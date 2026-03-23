(function installRemoteStorageExtensionProvider() {
  const SETTINGS_KEY = 'remotestorage:wireclient';
  const SHIM_FLAG = '__remoteStorageExtensionShimInstalled';
  const REMOTE_FLAG = '__remoteStorageExtensionRemotePatched';
  const LOG_PREFIX = '[rs-extension]';
  const CALL_TIMEOUT_MS = 5000;
  const USER_ADDRESS_INPUT_SELECTOR = [
    'input[type="email"]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[name*="address" i]',
    'input[id*="address" i]',
    'input[placeholder*="user" i]',
    'input[placeholder*="remoteStorage" i]',
    'input[aria-label*="user" i]',
    'input[aria-label*="address" i]'
  ].join(', ');

  function makeId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function isFolder(path) {
    return /\/$/.test(path);
  }

  function cleanPath(path) {
    return String(path)
      .replace(/\/+/g, '/')
      .replace(/'/g, '%27');
  }

  function isFolderDescription(body) {
    return body && body['@context'] === 'http://remotestorage.io/spec/folder-description'
      && typeof body.items === 'object';
  }

  function isSuccessStatus(status) {
    return [201, 204, 304].indexOf(status) >= 0;
  }

  function isErrorStatus(status) {
    return [401, 403, 404, 412].indexOf(status) >= 0;
  }

  function getActiveAccount(result) {
    const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
    return accounts.find((account) => {
      return account.active || account.accountId === result?.activeAccountId;
    }) || null;
  }

  function callExtension(method, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = makeId();
      let settled = false;

      function onMessage(event) {
        if (event.source !== window || !event.data) {
          return;
        }
        if (event.data.type !== 'remotestorage-bridge' || event.data.direction !== 'extension-to-page' || event.data.id !== id) {
          return;
        }

        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);

        if (event.data.error) {
          console.warn(LOG_PREFIX, method, 'error:', event.data.error.code, event.data.error.message);
          const error = new Error(event.data.error.message);
          error.code = event.data.error.code;
          reject(error);
          return;
        }

        console.debug(LOG_PREFIX, method, 'ok');
        resolve(event.data.payload);
      }

      window.addEventListener('message', onMessage);
      window.postMessage({
        type: 'remotestorage-bridge',
        id,
        direction: 'page-to-extension',
        method,
        payload,
      }, window.location.origin);

      setTimeout(function() {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onMessage);
        console.warn(LOG_PREFIX, method, 'timed out after', (timeoutMs || CALL_TIMEOUT_MS) + 'ms');
        var error = new Error('Extension bridge timed out.');
        error.code = 'timeout';
        reject(error);
      }, timeoutMs || CALL_TIMEOUT_MS);
    });
  }

  function scrubStoredSettings(userAddress) {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      const current = raw ? JSON.parse(raw) : {};
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        userAddress: userAddress || current.userAddress || null
      }));
    } catch (_error) {
      return;
    }
  }

  function toUnauthorizedError(RemoteStorage, message, code) {
    const error = new RemoteStorage.Unauthorized(message);
    error.code = code;
    return error;
  }

  async function normalizeBridgeResponse(method, path, response) {
    if (isErrorStatus(response.statusCode)) {
      return {
        statusCode: response.statusCode,
        revision: response.revision
      };
    }

    if (isSuccessStatus(response.statusCode) || (response.statusCode === 200 && method !== 'GET')) {
      return {
        statusCode: response.statusCode,
        revision: response.revision
      };
    }

    const normalized = {
      statusCode: response.statusCode,
      body: response.body,
      contentType: response.contentType,
      revision: response.statusCode === 200 ? response.revision : undefined
    };

    if (!isFolder(path)) {
      return normalized;
    }

    if (typeof normalized.body !== 'undefined') {
      if (typeof normalized.body === 'string') {
        normalized.body = JSON.parse(normalized.body);
      }
    }

    if (normalized.statusCode === 200 && typeof normalized.body === 'object' && normalized.body !== null) {
      let itemsMap = {};

      if (Object.keys(normalized.body).length === 0) {
        normalized.statusCode = 404;
      } else if (isFolderDescription(normalized.body)) {
        itemsMap = normalized.body.items;
      } else {
        Object.keys(normalized.body).forEach((key) => {
          itemsMap[key] = { ETag: normalized.body[key] };
        });
      }

      normalized.body = itemsMap;
    }

    return normalized;
  }

  function patchRemoteInstance(rs) {
    const remote = rs.remote;
    if (!remote) {
      throw new Error('remoteStorage remote transport is not initialized yet.');
    }

    if (remote[REMOTE_FLAG]) {
      return remote;
    }

    remote[REMOTE_FLAG] = true;
    remote.supportsRevs = true;
    remote.token = undefined;

    remote.disconnect = async function disconnectFromExtension() {
      if (this.sessionId) {
        await window.remoteStorageExtension.disconnect(this.sessionId);
      }
    };

    remote._bridgeRequest = async function bridgeRequest(method, path, headers, body) {
      if (this.isForbiddenRequestMethod(method, path)) {
        return Promise.reject(`Don't use ${method} on directories!`);
      }

      rs._emit('wire-busy', {
        method,
        isFolder: isFolder(path)
      });

      try {
        const response = await window.remoteStorageExtension.request({
          method,
          path: cleanPath(path),
          sessionId: this.sessionId,
          headers,
          body
        });
        const normalized = await normalizeBridgeResponse(method, path, response);

        if (!this.online) {
          this.online = true;
          rs._emit('network-online');
        }

        rs._emit('wire-done', {
          method,
          isFolder: isFolder(path),
          success: true
        });

        if (normalized.statusCode === 401) {
          rs._emit('error', new window.RemoteStorage.Unauthorized());
        }

        return normalized;
      } catch (error) {
        if (this.online) {
          this.online = false;
          rs._emit('network-offline');
        }

        rs._emit('wire-done', {
          method,
          isFolder: isFolder(path),
          success: false
        });

        throw error;
      }
    };

    remote.get = function getFromExtension(path, options = {}) {
      if (!this.connected) {
        return Promise.reject(`not connected (path: ${path})`);
      }

      const headers = {};
      if (this.supportsRevs && options.ifNoneMatch) {
        headers['If-None-Match'] = this.addQuotes(options.ifNoneMatch);
      }

      return this._bridgeRequest('GET', path, headers);
    };

    remote.put = function putToExtension(path, body, contentType, options = {}) {
      if (!this.connected) {
        return Promise.reject(`not connected (path: ${path})`);
      }

      const headers = {
        'Content-Type': contentType
      };

      if (this.supportsRevs) {
        if (options.ifMatch) {
          headers['If-Match'] = this.addQuotes(options.ifMatch);
        } else if (options.ifNoneMatch) {
          headers['If-None-Match'] = this.addQuotes(options.ifNoneMatch);
        }
      }

      return this._bridgeRequest('PUT', path, headers, body);
    };

    remote.delete = function deleteFromExtension(path, options = {}) {
      if (!this.connected) {
        return Promise.reject(`not connected (path: ${path})`);
      }

      const headers = {};
      if (this.supportsRevs && options.ifMatch) {
        headers['If-Match'] = this.addQuotes(options.ifMatch);
      }

      return this._bridgeRequest('DELETE', path, headers);
    };

    return remote;
  }

  async function connectViaExtension(rs, userAddress) {
    console.log(LOG_PREFIX, 'connecting via extension, userAddress:', userAddress || '(active account)');
    const bridgeState = await window.remoteStorageExtension.ping();
    console.log(LOG_PREFIX, 'ping result:', bridgeState?.accounts?.length, 'accounts, active:', bridgeState?.activeAccountId);

    const activeAccount = userAddress
      ? (Array.isArray(bridgeState.accounts) ? bridgeState.accounts.find((account) => {
        return String(account.userAddress).toLowerCase() === String(userAddress).toLowerCase();
      }) : null)
      : getActiveAccount(bridgeState);

    if (!activeAccount) {
      console.warn(LOG_PREFIX, 'no matching account in extension for:', userAddress);
      const noAccountError = new Error('No matching extension account is authenticated.');
      noAccountError.code = 'not_authenticated';
      throw noAccountError;
    }

    console.log(LOG_PREFIX, 'matched account:', activeAccount.userAddress, 'requesting connect');
    const location = window.location;
    let redirectUri = location.origin;
    if (location.pathname !== '/') {
      redirectUri += location.pathname;
    }
    const clientIdMatch = redirectUri.match(/^(https?:\/\/[^/]+)/);
    const scope = rs.access?.scopeParameter || '';
    console.log(LOG_PREFIX, 'app scopes:', scope || '(none, will default to *:rw)');

    const response = await window.remoteStorageExtension.connect({
      backend: 'remotestorage',
      origin: location.origin,
      userAddress: activeAccount.userAddress,
      href: activeAccount.href,
      storageApi: activeAccount.storageApi,
      authURL: activeAccount.authURL,
      properties: {},
      redirectUri,
      clientId: clientIdMatch ? clientIdMatch[0] : location.origin,
      requestedScopes: scope
    });

    console.log(LOG_PREFIX, 'connected, sessionId:', response.sessionId, 'grantedScopes:', response.grantedScopes);

    if (typeof rs.setBackend === 'function') {
      rs.setBackend('remotestorage');
    } else {
      rs.backend = 'remotestorage';
    }

    const remote = patchRemoteInstance(rs);
    remote.userAddress = response.userAddress;
    remote.href = response.href;
    remote.storageApi = response.storageApi;
    remote.properties = {};
    remote.sessionId = response.sessionId;
    remote.grantedScopes = response.grantedScopes || scope;
    remote.connected = true;
    remote.online = true;
    remote.token = undefined;
    scrubStoredSettings(response.userAddress);
    remote._emit('connected');
    return response;
  }

  function installRemoteStorageShim() {
    if (window[SHIM_FLAG] || !window.RemoteStorage || !window.RemoteStorage.prototype) {
      return;
    }

    const RemoteStorage = window.RemoteStorage;
    const originalConnect = RemoteStorage.prototype.connect;
    if (typeof originalConnect !== 'function') {
      return;
    }

    window[SHIM_FLAG] = true;
    console.log(LOG_PREFIX, 'shim installed — RemoteStorage.prototype.connect patched');

    RemoteStorage.prototype.connect = function patchedConnect(userAddress, token) {
      if (!window.remoteStorageExtension || typeof token !== 'undefined') {
        console.debug(LOG_PREFIX, 'bypass: token provided or extension unavailable');
        return originalConnect.apply(this, arguments);
      }

      const requestedUserAddress = typeof userAddress === 'string' ? userAddress.trim() : '';
      console.log(LOG_PREFIX, 'intercepted connect(', requestedUserAddress || '(no address)', ')');

      this._emit('connecting');
      this._emit('authing');

      connectViaExtension(this, requestedUserAddress || undefined).catch((error) => {
        console.warn(LOG_PREFIX, 'connect failed:', error?.code, error?.message);

        if (requestedUserAddress && error?.code === 'not_authenticated') {
          console.log(LOG_PREFIX, 'falling back to app OAuth (account not in extension)');
          originalConnect.call(this, requestedUserAddress, token);
          return;
        }

        if (error?.code === 'denied' || error?.code === 'access_denied') {
          this._emit('error', toUnauthorizedError(RemoteStorage, 'Authorization failed: access denied by extension', 'extension_denied'));
          return;
        }

        if (error?.code === 'not_authenticated') {
          this._emit('error', toUnauthorizedError(RemoteStorage, 'No remoteStorage account is authenticated in the extension.', 'extension_not_authenticated'));
          return;
        }

        if (requestedUserAddress) {
          console.log(LOG_PREFIX, 'falling back to app OAuth due to error:', error?.code || 'unknown');
          originalConnect.call(this, requestedUserAddress, token);
          return;
        }

        const discoveryError = new RemoteStorage.DiscoveryError('No user address supplied and no compatible remoteStorage extension account is available.');
        if (error?.message) {
          discoveryError.message = error.message;
        }
        this._emit('error', discoveryError);
      });
    };
  }

  function maybePopulateUserAddressInputs() {
    if (!window.remoteStorageExtension || !window.RemoteStorage) {
      return;
    }

    window.remoteStorageExtension.ping().then((result) => {
      const activeAccount = getActiveAccount(result);
      if (!activeAccount) {
        return;
      }

      const inputs = document.querySelectorAll(USER_ADDRESS_INPUT_SELECTOR);
      inputs.forEach((input) => {
        if (!(input instanceof HTMLInputElement)) {
          return;
        }

        if (input.value.trim()) {
          return;
        }

        input.value = activeAccount.userAddress;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });

      if (inputs.length > 0) {
        console.log(LOG_PREFIX, 'pre-filled', inputs.length, 'address input(s) with', activeAccount.userAddress);
      }
    }).catch(() => undefined);
  }

  function watchForRemoteStorage() {
    installRemoteStorageShim();
    maybePopulateUserAddressInputs();

    if (window[SHIM_FLAG]) {
      return;
    }

    const interval = window.setInterval(() => {
      installRemoteStorageShim();
      maybePopulateUserAddressInputs();
      if (window[SHIM_FLAG]) {
        window.clearInterval(interval);
      }
    }, 250);

    window.setTimeout(() => {
      window.clearInterval(interval);
      if (!window[SHIM_FLAG]) {
        console.debug(LOG_PREFIX, 'gave up waiting for window.RemoteStorage after 15s');
      }
    }, 15000);
  }

  window.remoteStorageExtension = {
    version: 1,
    ping() {
      return callExtension('ping', {});
    },
    connect(request) {
      return callExtension('connect', request);
    },
    request(request) {
      return callExtension('request', request);
    },
    disconnect(sessionId) {
      return callExtension('disconnect', sessionId);
    }
  };

  // Bridge: translate CustomEvent protocol (used by remoteStorage.js library)
  // into postMessage protocol (used by the extension's content script).
  // CustomEvents can't cross Chrome's isolated world boundary, but postMessage
  // can. injected.js runs in the MAIN world alongside the library, so it can
  // intercept CustomEvents and relay them through postMessage.
  const BRIDGE_EVENT = 'remotestorage-bridge';
  document.addEventListener(BRIDGE_EVENT, function onLibraryBridgeEvent(event) {
    const detail = event.detail;
    if (!detail || detail.direction !== 'page-to-extension' || !detail.id) {
      return;
    }

    // Forward to content script via postMessage
    callExtension(detail.method, detail.payload).then(function(payload) {
      document.dispatchEvent(new CustomEvent(BRIDGE_EVENT, {
        detail: {
          id: detail.id,
          direction: 'extension-to-page',
          payload: payload,
        }
      }));
    }).catch(function(error) {
      document.dispatchEvent(new CustomEvent(BRIDGE_EVENT, {
        detail: {
          id: detail.id,
          direction: 'extension-to-page',
          error: {
            code: error && error.code || 'request_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }));
    });
  });

  console.log(LOG_PREFIX, 'loaded, window.remoteStorageExtension ready');
  watchForRemoteStorage();
  document.addEventListener('DOMContentLoaded', maybePopulateUserAddressInputs, { once: true });
  const observer = new MutationObserver(() => {
    installRemoteStorageShim();
    maybePopulateUserAddressInputs();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
