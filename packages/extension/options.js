const STORAGE_KEYS = {
  accounts: 'accounts',
  activeAccountId: 'activeAccountId',
  allowedOrigins: 'allowedOrigins',
};

const elements = {
  accountsList: document.querySelector('#accounts-list'),
  accountsEmpty: document.querySelector('#accounts-empty'),
  originsList: document.querySelector('#origins-list'),
  originsEmpty: document.querySelector('#origins-empty'),
  toast: document.querySelector('#toast'),
};

let toastTimer = null;

function showToast(kind, message) {
  clearTimeout(toastTimer);
  elements.toast.className = `toast visible toast-${kind}`;
  elements.toast.textContent = message;
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, 3000);
}

function getInitial(userAddress) {
  const name = String(userAddress).split('@')[0] || '?';
  return name.charAt(0).toUpperCase();
}

function getServerHost(href) {
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function humanizeScopes(scopeString) {
  const scopes = String(scopeString || '').trim();
  if (!scopes) return 'none';
  if (scopes === '*:rw') return 'full read/write';
  if (scopes === '*:r') return 'full read-only';
  return scopes;
}

async function sendPopupMessage(payload) {
  const response = await chrome.runtime.sendMessage({
    type: 'rs-extension-popup',
    ...payload,
  });

  if (response?.error) {
    const error = new Error(response.error.message);
    error.code = response.error.code;
    throw error;
  }

  return response?.payload;
}

async function renderAccounts() {
  const state = await chrome.storage.local.get([STORAGE_KEYS.accounts, STORAGE_KEYS.activeAccountId]);
  const accountsById = state[STORAGE_KEYS.accounts] || {};
  const activeAccountId = state[STORAGE_KEYS.activeAccountId] || null;
  const accounts = Object.values(accountsById).sort((a, b) =>
    a.userAddress.localeCompare(b.userAddress)
  );

  elements.accountsList.textContent = '';

  if (accounts.length === 0) {
    elements.accountsEmpty.style.display = '';
    return;
  }

  elements.accountsEmpty.style.display = 'none';

  accounts.forEach((account) => {
    const isActive = account.accountId === activeAccountId;

    const row = document.createElement('div');
    row.className = 'account-row' + (isActive ? ' active' : '');

    const avatar = document.createElement('div');
    avatar.className = 'account-avatar';
    avatar.textContent = getInitial(account.userAddress);

    const info = document.createElement('div');
    info.className = 'account-info';

    const name = document.createElement('div');
    name.className = 'account-info-name';
    name.textContent = account.userAddress;

    const detail = document.createElement('div');
    detail.className = 'account-info-detail';
    detail.textContent = getServerHost(account.href) + ' \u00b7 ' + (account.storageApi || 'unknown API');

    info.appendChild(name);
    info.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'account-row-actions';

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-active';
      badge.textContent = 'Active';
      actions.appendChild(badge);
    } else {
      const activateBtn = document.createElement('button');
      activateBtn.className = 'btn btn-secondary';
      activateBtn.textContent = 'Set active';
      activateBtn.style.fontSize = '11px';
      activateBtn.style.padding = '4px 10px';
      activateBtn.addEventListener('click', async () => {
        try {
          await sendPopupMessage({ action: 'setActiveAccount', accountId: account.accountId });
          showToast('success', 'Active account updated');
          renderAccounts();
        } catch (error) {
          showToast('error', error instanceof Error ? error.message : String(error));
        }
      });
      actions.appendChild(activateBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      try {
        await sendPopupMessage({ action: 'removeAccount', accountId: account.accountId });
        showToast('success', 'Account removed');
        renderAccounts();
      } catch (error) {
        showToast('error', error instanceof Error ? error.message : String(error));
      }
    });
    actions.appendChild(removeBtn);

    row.appendChild(avatar);
    row.appendChild(info);
    row.appendChild(actions);
    elements.accountsList.appendChild(row);
  });
}

async function renderOrigins() {
  const state = await chrome.storage.local.get(STORAGE_KEYS.allowedOrigins);
  const origins = state[STORAGE_KEYS.allowedOrigins] || {};
  const entries = Object.entries(origins).sort(([a], [b]) => a.localeCompare(b));

  elements.originsList.textContent = '';

  if (entries.length === 0) {
    elements.originsEmpty.style.display = '';
    return;
  }

  elements.originsEmpty.style.display = 'none';

  entries.forEach(([origin, decision]) => {
    const row = document.createElement('div');
    row.className = 'origin-row';

    const info = document.createElement('div');
    info.className = 'origin-info';

    const url = document.createElement('div');
    url.className = 'origin-url';
    url.textContent = origin;

    const meta = document.createElement('div');
    meta.className = 'origin-scopes';

    const statusBadge = document.createElement('span');
    statusBadge.className = 'badge' + (decision.approved ? ' badge-active' : '');
    statusBadge.textContent = decision.approved ? 'Allowed' : 'Denied';
    meta.appendChild(statusBadge);

    meta.appendChild(document.createTextNode(' '));

    const scopeBadge = document.createElement('span');
    scopeBadge.className = 'badge-scope';
    scopeBadge.textContent = humanizeScopes(decision.scopes);
    meta.appendChild(scopeBadge);

    if (decision.approvedAt) {
      const dateText = document.createTextNode(' \u00b7 ' + formatDate(decision.approvedAt));
      meta.appendChild(dateText);
    }

    info.appendChild(url);
    info.appendChild(meta);

    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'btn btn-danger';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', async () => {
      const updated = { ...origins };
      delete updated[origin];
      await chrome.storage.local.set({ [STORAGE_KEYS.allowedOrigins]: updated });
      showToast('success', 'Access revoked for ' + origin);
      renderOrigins();
    });

    row.appendChild(info);
    row.appendChild(revokeBtn);
    elements.originsList.appendChild(row);
  });
}

// Init
renderAccounts().catch(console.error);
renderOrigins().catch(console.error);

// Live updates
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEYS.accounts] || changes[STORAGE_KEYS.activeAccountId]) {
    renderAccounts().catch(console.error);
  }
  if (changes[STORAGE_KEYS.allowedOrigins]) {
    renderOrigins().catch(console.error);
  }
});
