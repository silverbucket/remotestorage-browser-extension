const params = new URLSearchParams(window.location.search);
const consentId = params.get('consentId');

const elements = {
  loading: document.querySelector('#loading'),
  details: document.querySelector('#details'),
  originValue: document.querySelector('#origin-value'),
  scopesValue: document.querySelector('#scopes-value'),
  accountValue: document.querySelector('#account-value'),
  rememberLabel: document.querySelector('#remember-label'),
  remember: document.querySelector('#remember'),
  actions: document.querySelector('#consent-actions'),
  allowBtn: document.querySelector('#allow-btn'),
  denyBtn: document.querySelector('#deny-btn'),
  error: document.querySelector('#error'),
};

function humanizeScopes(scopeString) {
  const scopes = String(scopeString || '').trim();
  if (!scopes) return 'none requested';
  if (scopes === '*:rw') return 'full read + write';
  if (scopes === '*:r') return 'full read-only';

  return scopes.split(/\s+/).map((s) => {
    const [name, mode] = s.split(':');
    const modeLabel = mode === 'rw' ? 'read/write' : 'read-only';
    return `${name} (${modeLabel})`;
  }).join(', ');
}

function renderScopeTags(scopeString) {
  const scopes = String(scopeString || '').trim();
  if (!scopes) {
    elements.scopesValue.textContent = 'none requested';
    return;
  }

  elements.scopesValue.textContent = '';
  scopes.split(/\s+/).forEach((scope, i) => {
    if (i > 0) {
      elements.scopesValue.appendChild(document.createTextNode(' '));
    }
    const tag = document.createElement('span');
    tag.className = 'scope-tag';
    tag.textContent = humanizeScopes(scope);
    elements.scopesValue.appendChild(tag);
  });
}

function showError(message) {
  elements.loading.hidden = true;
  elements.error.hidden = false;
  elements.error.textContent = message;
}

async function sendConsentMessage(payload) {
  return chrome.runtime.sendMessage({
    type: 'rs-extension-consent',
    consentId,
    ...payload,
  });
}

async function respond(approved) {
  elements.allowBtn.disabled = true;
  elements.denyBtn.disabled = true;

  try {
    await sendConsentMessage({
      action: 'consentResponse',
      approved,
      remember: elements.remember.checked,
    });

    window.close();
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    elements.allowBtn.disabled = false;
    elements.denyBtn.disabled = false;
  }
}

async function init() {
  if (!consentId) {
    showError('Missing consent request ID.');
    return;
  }

  try {
    const response = await sendConsentMessage({
      action: 'getConsentRequest',
    });

    if (response?.error) {
      showError(response.error.message || 'Unknown error.');
      return;
    }

    const details = response?.payload;
    if (!details) {
      showError('Could not load consent request details.');
      return;
    }

    elements.originValue.textContent = details.origin;
    renderScopeTags(details.requestedScopes);
    elements.accountValue.textContent = details.userAddress || 'active account';

    elements.loading.hidden = true;
    elements.details.hidden = false;
    elements.rememberLabel.hidden = false;
    elements.actions.hidden = false;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
}

elements.allowBtn.addEventListener('click', () => respond(true));
elements.denyBtn.addEventListener('click', () => respond(false));

init();
