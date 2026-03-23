const BRIDGE_VERSION = 1;
const STORAGE_KEYS = {
  accounts: 'accounts',
  activeAccountId: 'activeAccountId',
  allowedOrigins: 'allowedOrigins',
};
const sessions = new Map();
const pendingConsents = new Map();

function normalizeScopeSet(scopeString) {
  return String(scopeString || '')
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean)
    .sort()
    .join(' ');
}

function scopeSetIncludes(existing, requested) {
  const existingSet = new Set(normalizeScopeSet(existing).split(' ').filter(Boolean));
  const requestedSet = normalizeScopeSet(requested).split(' ').filter(Boolean);
  return requestedSet.every(scope => existingSet.has(scope));
}

// The extension requests full access (*:rw) when authenticating with RS servers.
// This is by design: the extension acts as a shared broker for multiple apps.
// Per-app scope enforcement happens in-process via checkPathPermission() on
// every request, using the scopes the user approved in the consent UI.
function storageScopeForFullAccess(storageApi) {
  if (storageApi === '2012.04') {
    return ':rw';
  }
  if (/remotestorage-0[01]/.test(storageApi || '')) {
    return 'root:rw';
  }
  return '*:rw';
}

function accountIdFor(userAddress) {
  return userAddress.toLowerCase();
}

function makeSessionId() {
  return crypto.randomUUID();
}

function cleanPath(path) {
  return String(path)
    .replace(/\/+/g, '/')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
    .replace(/'/g, '%27');
}

function parseModuleName(path) {
  const normalized = String(path || '');
  const match = normalized.replace(/^\/public/, '').match(/^\/([^/]*)\//);
  return match ? match[1] : '*';
}

function modeAllows(grantedMode, requestedMode) {
  return grantedMode && (requestedMode === 'r' || grantedMode === 'rw');
}

function checkPathPermission(scopeString, path, method) {
  const requiredMode = method === 'GET' ? 'r' : 'rw';
  const scopes = normalizeScopeSet(scopeString)
    .split(' ')
    .filter(Boolean)
    .map(entry => {
      const [name, mode] = entry.split(':');
      return { name, mode };
    });

  const wildcard = scopes.find(scope => scope.name === '*' || scope.name === 'root' || scope.name === '');
  if (wildcard && modeAllows(wildcard.mode, requiredMode)) {
    return true;
  }

  const moduleName = parseModuleName(path);
  const match = scopes.find(scope => scope.name === moduleName);
  return Boolean(match && modeAllows(match.mode, requiredMode));
}

function isTextContentType(contentType) {
  if (!contentType) {
    return true;
  }
  return contentType.startsWith('text/') ||
    [
      'application/ecmascript',
      'application/javascript',
      'application/json',
      'application/mathml+xml',
      'application/xhtml+xml',
      'application/xml',
      'application/x-yaml',
      'image/svg+xml',
      'message/rfc822',
    ].some(type => contentType.includes(type));
}

function getResponseRevision(response) {
  const etag = response.headers.get('ETag');
  return etag ? etag.replace(/^["']|["']$/g, '') : undefined;
}

async function parseResponseBody(response) {
  if ([200, 201].indexOf(response.status) === -1) {
    return undefined;
  }
  if (response.status === 204 || response.status === 304) {
    return undefined;
  }

  const contentType = response.headers.get('Content-Type') || undefined;
  if (isTextContentType(contentType)) {
    return response.text();
  }
  return response.arrayBuffer();
}

function isLikelyLocalHost(host) {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i.test(host);
}

function webFingerUrlsFor(userAddress, host) {
  const resource = encodeURIComponent(`acct:${userAddress}`);
  const path = `/.well-known/webfinger?resource=${resource}`;
  const protocols = isLikelyLocalHost(host) ? ['http', 'https'] : ['https', 'http'];
  return protocols.map((protocol) => `${protocol}://${host}${path}`);
}

async function fetchWebFingerDocument(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/jrd+json, application/json;q=0.9, */*;q=0.1',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`WebFinger lookup failed with status ${response.status}.`);
  }

  const contentType = response.headers.get('Content-Type') || '';
  const bodyText = await response.text();
  const trimmedBody = bodyText.trim();

  if (!trimmedBody) {
    throw new Error('WebFinger lookup returned an empty response.');
  }

  const looksLikeJson = contentType.includes('json') || contentType.includes('jrd') || /^[{\[]/.test(trimmedBody);
  if (!looksLikeJson) {
    const snippet = trimmedBody.slice(0, 80).replace(/\s+/g, ' ');
    throw new Error(`WebFinger endpoint returned ${contentType || 'non-JSON content'} instead of JSON (${snippet}).`);
  }

  try {
    return JSON.parse(trimmedBody);
  } catch (_error) {
    throw new Error('WebFinger endpoint returned invalid JSON.');
  }
}

async function loadState() {
  const state = await chrome.storage.local.get([STORAGE_KEYS.accounts, STORAGE_KEYS.activeAccountId]);
  return {
    accounts: state[STORAGE_KEYS.accounts] || {},
    activeAccountId: state[STORAGE_KEYS.activeAccountId] || null,
  };
}

async function saveState(accounts, activeAccountId) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.accounts]: accounts,
    [STORAGE_KEYS.activeAccountId]: activeAccountId,
  });
}

function serializeAccounts(accounts, activeAccountId) {
  return Object.values(accounts)
    .sort((a, b) => a.userAddress.localeCompare(b.userAddress))
    .map(account => ({
      accountId: account.accountId,
      active: account.accountId === activeAccountId,
      authURL: account.authURL,
      addedAt: account.addedAt,
      href: account.href,
      storageApi: account.storageApi,
      userAddress: account.userAddress,
    }));
}

async function discoverAccount(userAddress) {
  const normalizedUserAddress = String(userAddress || '').trim();
  if (!normalizedUserAddress || normalizedUserAddress.indexOf('@') < 0) {
    throw new Error('Please enter a valid user address.');
  }

  const [, host] = normalizedUserAddress.split('@');
  const urls = webFingerUrlsFor(normalizedUserAddress, host);
  let data;
  let lastError;

  for (const url of urls) {
    try {
      data = await fetchWebFingerDocument(url);
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!data) {
    throw lastError || new Error('WebFinger lookup failed.');
  }

  const link = Array.isArray(data.links)
    ? data.links.find(entry => entry.rel === 'http://tools.ietf.org/id/draft-dejong-remotestorage')
    : undefined;

  if (!link || !link.href) {
    throw new Error(`No remoteStorage endpoint found for ${normalizedUserAddress}.`);
  }

  return {
    accountId: accountIdFor(normalizedUserAddress),
    addedAt: Date.now(),
    authURL: link.properties?.['http://tools.ietf.org/html/rfc6749#section-4.2'] || link.properties?.['auth-endpoint'],
    href: link.href,
    storageApi: link.properties?.['http://remotestorage.io/spec/version'] || link.type,
    userAddress: normalizedUserAddress,
  };
}

async function authenticateAccount(discovered) {
  if (!discovered.authURL) {
    return {
      ...discovered,
      token: null,
      tokenType: null,
    };
  }

  const redirectUri = chrome.identity.getRedirectURL('rs-extension');
  const clientId = new URL(redirectUri).origin;
  const authUrl = new URL(discovered.authURL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('scope', storageScopeForFullAccess(discovered.storageApi));
  authUrl.searchParams.set('state', discovered.accountId);

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    interactive: true,
    url: authUrl.href,
  });

  if (!responseUrl) {
    throw new Error('Extension authentication did not complete.');
  }

  const params = new URL(responseUrl).hash.startsWith('#')
    ? new URLSearchParams(new URL(responseUrl).hash.substring(1))
    : new URLSearchParams(new URL(responseUrl).search);

  if (params.get('error')) {
    const errorCode = params.get('error');
    const error = new Error(params.get('error_description') || errorCode || 'Authorization failed.');
    error.code = errorCode;
    throw error;
  }

  const accessToken = params.get('access_token');
  if (!accessToken) {
    throw new Error('Extension authentication did not return an access token.');
  }

  return {
    ...discovered,
    token: accessToken,
    tokenType: params.get('token_type') || 'Bearer',
  };
}

async function addAccount(userAddress) {
  const discovered = await discoverAccount(userAddress);
  const authenticated = await authenticateAccount(discovered);
  const state = await loadState();
  const accounts = {
    ...state.accounts,
    [authenticated.accountId]: authenticated,
  };
  const activeAccountId = state.activeAccountId || authenticated.accountId;
  await saveState(accounts, activeAccountId);
  return {
    accounts: serializeAccounts(accounts, activeAccountId),
    activeAccountId,
  };
}

async function removeAccount(accountId) {
  const state = await loadState();
  const accounts = { ...state.accounts };
  delete accounts[accountId];
  const remainingIds = Object.keys(accounts);
  const activeAccountId = state.activeAccountId === accountId
    ? (remainingIds[0] || null)
    : state.activeAccountId;
  await saveState(accounts, activeAccountId);
  return {
    accounts: serializeAccounts(accounts, activeAccountId),
    activeAccountId,
  };
}

async function setActiveAccount(accountId) {
  const state = await loadState();
  if (accountId && !state.accounts[accountId]) {
    throw new Error('Unknown account.');
  }
  await saveState(state.accounts, accountId);
  return {
    accounts: serializeAccounts(state.accounts, accountId),
    activeAccountId: accountId,
  };
}

async function listAccounts() {
  const state = await loadState();
  return {
    accounts: serializeAccounts(state.accounts, state.activeAccountId),
    activeAccountId: state.activeAccountId,
  };
}

async function getOriginAllowlist() {
  const state = await chrome.storage.local.get(STORAGE_KEYS.allowedOrigins);
  return state[STORAGE_KEYS.allowedOrigins] || {};
}

async function setOriginDecision(origin, decision) {
  const allowlist = await getOriginAllowlist();
  allowlist[origin] = decision;
  await chrome.storage.local.set({ [STORAGE_KEYS.allowedOrigins]: allowlist });
}

function isOriginApproved(allowlist, origin, requestedScopes) {
  const entry = allowlist[origin];
  if (!entry || !entry.approved) {
    return false;
  }
  return scopeSetIncludes(entry.scopes, requestedScopes);
}

function requestUserConsent(consentId, details) {
  return new Promise((resolve) => {
    const consentUrl = chrome.runtime.getURL(
      `consent.html?consentId=${encodeURIComponent(consentId)}`
    );

    chrome.windows.create({
      url: consentUrl,
      type: 'popup',
      width: 420,
      height: 480,
      focused: true,
    }, (win) => {
      pendingConsents.set(consentId, {
        ...details,
        resolve,
        windowId: win.id,
      });
    });
  });
}

function senderOrigin(sender) {
  if (!sender?.url) {
    return null;
  }
  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
  }
}

async function resolveAccountForConnect(payload) {
  const state = await loadState();
  const requestedUserAddress = payload.userAddress ? accountIdFor(payload.userAddress) : null;
  const account = requestedUserAddress
    ? state.accounts[requestedUserAddress]
    : state.accounts[state.activeAccountId];

  if (!account) {
    const error = new Error('No matching extension account is authenticated.');
    error.code = 'not_authenticated';
    throw error;
  }

  if (!payload.userAddress) {
    payload.userAddress = account.userAddress;
  }

  return { account, state };
}

async function createSession(payload, tabId) {
  const { account } = await resolveAccountForConnect(payload);
  const sessionId = makeSessionId();

  sessions.set(sessionId, {
    accountId: account.accountId,
    grantedScopes: normalizeScopeSet(payload.requestedScopes),
    href: account.href,
    origin: payload.origin,
    storageApi: account.storageApi,
    tabId,
    token: account.token,
    tokenType: account.tokenType || 'Bearer',
    userAddress: account.userAddress,
  });

  return {
    sessionId,
    userAddress: account.userAddress,
    href: account.href,
    storageApi: account.storageApi,
    grantedScopes: normalizeScopeSet(payload.requestedScopes),
  };
}

async function performRemoteRequest(session, payload) {
  if (!checkPathPermission(session.grantedScopes, payload.path, payload.method)) {
    return {
      statusCode: 403,
    };
  }

  const baseHref = session.href.endsWith('/') ? session.href.slice(0, -1) : session.href;
  const url = `${baseHref}${cleanPath(payload.path)}`;
  const headers = new Headers(payload.headers || {});

  if (session.token) {
    headers.set('Authorization', `${session.tokenType || 'Bearer'} ${session.token}`);
  }

  const response = await fetch(url, {
    body: payload.method === 'PUT' ? payload.body : undefined,
    credentials: 'include',
    headers,
    method: payload.method,
  });

  const body = await parseResponseBody(response);
  return {
    body,
    contentType: response.headers.get('Content-Type') || undefined,
    revision: getResponseRevision(response),
    statusCode: response.status,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'rs-extension-popup') {
    (async () => {
      switch (message.action) {
        case 'listAccounts':
          sendResponse({ payload: await listAccounts() });
          return;
        case 'addAccount':
          sendResponse({ payload: await addAccount(message.userAddress) });
          return;
        case 'removeAccount':
          sendResponse({ payload: await removeAccount(message.accountId) });
          return;
        case 'setActiveAccount':
          sendResponse({ payload: await setActiveAccount(message.accountId) });
          return;
        default:
          sendResponse({
            error: {
              code: 'unsupported',
              message: `Unknown popup action ${message.action}.`,
            }
          });
      }
    })().catch((error) => {
      sendResponse({
        error: {
          code: error?.code || 'request_failed',
          message: error instanceof Error ? error.message : String(error?.message || error),
        }
      });
    });
    return true;
  }

  if (message?.type === 'rs-extension-consent') {
    (async () => {
      if (message.action === 'getConsentRequest') {
        const pending = pendingConsents.get(message.consentId);
        if (!pending) {
          sendResponse({ error: { code: 'not_found', message: 'Unknown consent request.' } });
          return;
        }
        sendResponse({
          payload: {
            origin: pending.origin,
            requestedScopes: pending.requestedScopes,
            userAddress: pending.userAddress,
          }
        });
        return;
      }

      if (message.action === 'consentResponse') {
        const pending = pendingConsents.get(message.consentId);
        if (!pending) {
          sendResponse({ error: { code: 'not_found', message: 'Unknown consent request.' } });
          return;
        }
        pendingConsents.delete(message.consentId);
        pending.resolve({
          approved: Boolean(message.approved),
          remember: Boolean(message.remember),
        });
        sendResponse({ payload: { ok: true } });
        return;
      }

      sendResponse({ error: { code: 'unsupported', message: 'Unknown consent action.' } });
    })().catch((error) => {
      sendResponse({
        error: {
          code: error?.code || 'request_failed',
          message: error instanceof Error ? error.message : String(error?.message || error),
        }
      });
    });
    return true;
  }

  if (message?.type !== 'rs-extension-bridge') {
    return undefined;
  }

  const trustedOrigin = senderOrigin(sender);
  const tabId = sender.tab?.id;

  if (typeof tabId !== 'number') {
    sendResponse({
      error: { code: 'invalid_context', message: 'Bridge messages must originate from a tab.' }
    });
    return true;
  }

  (async () => {
    switch (message.method) {
      case 'ping': {
        const state = await listAccounts();
        sendResponse({
          payload: {
            version: BRIDGE_VERSION,
            activeAccountId: state.activeAccountId,
            accounts: state.accounts,
          }
        });
        return;
      }

      case 'connect': {
        const payload = message.payload || {};

        if (!payload.origin || !payload.requestedScopes) {
          sendResponse({
            error: {
              code: 'invalid_request',
              message: 'Invalid connect payload.'
            }
          });
          return;
        }

        if (trustedOrigin && payload.origin !== trustedOrigin) {
          sendResponse({
            error: {
              code: 'origin_mismatch',
              message: 'Claimed origin does not match sender.',
            }
          });
          return;
        }

        const allowlist = await getOriginAllowlist();
        if (!isOriginApproved(allowlist, trustedOrigin, payload.requestedScopes)) {
          const consentId = crypto.randomUUID();

          // Deduplicate: if consent is already pending for same origin, wait for it
          const existingConsent = Array.from(pendingConsents.values()).find(
            (p) => p.origin === trustedOrigin
          );
          let consentResult;
          if (existingConsent) {
            consentResult = await new Promise((resolve) => {
              const existingResolve = existingConsent.resolve;
              existingConsent.resolve = (result) => {
                existingResolve(result);
                resolve(result);
              };
            });
          } else {
            consentResult = await requestUserConsent(consentId, {
              origin: trustedOrigin,
              requestedScopes: payload.requestedScopes,
              userAddress: payload.userAddress,
            });
          }

          if (!consentResult.approved) {
            sendResponse({
              error: { code: 'denied', message: 'User denied access.' }
            });
            return;
          }

          if (consentResult.remember) {
            await setOriginDecision(trustedOrigin, {
              approved: true,
              scopes: normalizeScopeSet(payload.requestedScopes),
              approvedAt: Date.now(),
              userAddress: payload.userAddress,
            });
          }
        }

        const session = await createSession(payload, tabId);
        sendResponse({ payload: session });
        return;
      }

      case 'request': {
        const payload = message.payload || {};
        const session = payload.sessionId ? sessions.get(payload.sessionId) : undefined;

        if (!session) {
          sendResponse({ payload: { statusCode: 401 } });
          return;
        }

        if (session.tabId !== tabId) {
          sendResponse({ payload: { statusCode: 403 } });
          return;
        }

        if (trustedOrigin && session.origin !== trustedOrigin) {
          sendResponse({ payload: { statusCode: 403 } });
          return;
        }

        if (!payload.path || !payload.method) {
          sendResponse({
            error: {
              code: 'invalid_request',
              message: 'Invalid request payload.'
            }
          });
          return;
        }

        const response = await performRemoteRequest(session, payload);
        sendResponse({ payload: response });
        return;
      }

      case 'disconnect': {
        const sessionId = typeof message.payload === 'string'
          ? message.payload
          : message.payload?.sessionId;

        if (sessionId) {
          const session = sessions.get(sessionId);
          if (session && session.tabId === tabId) {
            sessions.delete(sessionId);
          }
        }

        sendResponse({ payload: { ok: true } });
        return;
      }

      default:
        sendResponse({
          error: {
            code: 'unsupported',
            message: `Unknown bridge method ${message.method}.`
          }
        });
    }
  })().catch((error) => {
    sendResponse({
      error: {
        code: error?.code || 'request_failed',
        message: error instanceof Error ? error.message : String(error?.message || error)
      }
    });
  });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [sessionId, session] of sessions) {
    if (session.tabId === tabId) {
      sessions.delete(sessionId);
    }
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [consentId, pending] of pendingConsents) {
    if (pending.windowId === windowId) {
      pending.resolve({ approved: false, remember: false });
      pendingConsents.delete(consentId);
    }
  }
});
