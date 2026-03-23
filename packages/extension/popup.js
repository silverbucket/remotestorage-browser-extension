const elements = {
  accounts: document.querySelector('#accounts'),
  accountsEmpty: document.querySelector('#accounts-empty'),
  accountsPanel: document.querySelector('#accounts-panel'),
  accountPill: document.querySelector('#account-pill'),
  activeAccount: document.querySelector('#active-account'),
  addAccount: document.querySelector('#add-account'),
  metricActive: document.querySelector('#metric-active'),
  metricMode: document.querySelector('#metric-mode'),
  phasePill: document.querySelector('#phase-pill'),
  setActive: document.querySelector('#set-active'),
  statusDetail: document.querySelector('#status-detail'),
  statusKind: document.querySelector('#status-kind'),
  statusMessage: document.querySelector('#status-message'),
  statusTitle: document.querySelector('#status-title'),
  userAddress: document.querySelector('#user-address'),
};

const STORAGE_KEYS = {
  accounts: 'accounts',
  activeAccountId: 'activeAccountId',
};

function setBusy(isBusy, phaseLabel = 'Idle') {
  document.body.classList.toggle('busy', isBusy);
  elements.phasePill.textContent = phaseLabel;
}

function formatSummary(value) {
  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function setStatus(kind, title, message, detail = '') {
  elements.statusKind.textContent = kind;
  elements.statusTitle.textContent = title;
  elements.statusMessage.textContent = message;
  elements.statusDetail.textContent = detail ? formatSummary(detail) : '';
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

async function readStoredState() {
  const state = await chrome.storage.local.get([STORAGE_KEYS.accounts, STORAGE_KEYS.activeAccountId]);
  const accountsById = state[STORAGE_KEYS.accounts] || {};
  const activeAccountId = state[STORAGE_KEYS.activeAccountId] || null;
  const accounts = Object.values(accountsById)
    .sort((a, b) => a.userAddress.localeCompare(b.userAddress))
    .map((account) => ({
      accountId: account.accountId,
      active: account.accountId === activeAccountId,
      authURL: account.authURL,
      addedAt: account.addedAt,
      href: account.href,
      storageApi: account.storageApi,
      userAddress: account.userAddress,
    }));

  return {
    accounts,
    activeAccountId,
  };
}

function renderSummary(state) {
  const accounts = state.accounts || [];
  const activeAccount = accounts.find((account) => account.active) || null;

  elements.metricActive.textContent = activeAccount ? activeAccount.userAddress : 'none selected';
  elements.metricMode.textContent = accounts.length > 0 ? 'ready for brokered apps' : 'waiting for first account';
  elements.accountPill.textContent = accounts.length === 0
    ? 'Empty vault'
    : `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
}

function attachRemoveHandlers() {
  elements.accounts.querySelectorAll('button[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      const accountId = button.dataset.remove;
      if (!accountId) {
        return;
      }

      setBusy(true, 'Updating');
      setStatus('mutation', 'Removing stored account', 'Updating the cached account list after removing this identity.');

      try {
        const payload = await sendPopupMessage({
          action: 'removeAccount',
          accountId,
        });
        renderAccounts(payload);
        setStatus('ready', 'Account removed', 'The extension cache has been updated.', payload);
      } catch (error) {
        setStatus('error', 'Could not remove account', error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    });
  });
}

function renderAccounts(state) {
  const accounts = state.accounts || [];
  elements.activeAccount.innerHTML = '';
  renderSummary(state);

  if (accounts.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No accounts';
    elements.activeAccount.appendChild(option);
    elements.accounts.innerHTML = '';
    elements.accountsPanel.classList.add('hidden');
    elements.accountsEmpty.hidden = false;
    document.body.classList.add('loaded');
    document.body.classList.remove('loading');
    return;
  }

  elements.accountsPanel.classList.remove('hidden');
  elements.accountsEmpty.hidden = true;
  elements.accounts.innerHTML = '';

  accounts.forEach((account) => {
    const option = document.createElement('option');
    option.value = account.accountId;
    option.textContent = account.userAddress;
    option.selected = account.active;
    elements.activeAccount.appendChild(option);

    const item = document.createElement('li');
    item.className = `account-card${account.active ? ' active' : ''}`;
    item.innerHTML = `
      <div class="account-top">
        <div>
          <h3 class="account-name">${account.userAddress}</h3>
          <div class="account-meta">
            <div><code>${account.href}</code></div>
            <div>Storage API: <code>${account.storageApi}</code></div>
          </div>
        </div>
        <span class="pill${account.active ? ' active' : ''}">${account.active ? 'Active' : 'Stored'}</span>
      </div>
      <div class="account-actions actions">
        <button data-remove="${account.accountId}" class="ghost">Remove</button>
      </div>
    `;
    elements.accounts.appendChild(item);
  });

  attachRemoveHandlers();
  document.body.classList.add('loaded');
  document.body.classList.remove('loading');
}

async function refreshAccounts({ warm = false } = {}) {
  if (warm) {
    setStatus('cache', 'Restoring stored identities', 'Reading the extension cache so the popup can render immediately.');
  }

  const payload = await readStoredState();
  renderAccounts(payload);

  if (payload.accounts.length === 0) {
    setStatus('ready', 'No authenticated accounts yet', 'Add a remoteStorage identity above and the extension will keep it ready for apps.');
  } else {
    const activeAccount = payload.accounts.find((account) => account.active);
    setStatus(
      'ready',
      'Cached account state is ready',
      activeAccount
        ? `Using ${activeAccount.userAddress} as the active extension identity.`
        : 'Accounts are stored, but no active identity is selected.',
      payload,
    );
  }
}

elements.addAccount.addEventListener('click', async () => {
  const userAddress = elements.userAddress.value.trim();
  if (!userAddress) {
    setStatus('attention', 'User address needed', 'Enter a remoteStorage address like user@example.com to begin extension-owned authentication.');
    return;
  }

  setBusy(true, 'Authenticating');
  setStatus('auth', 'Launching authentication flow', `Opening secure browser auth for ${userAddress}.`, {
    userAddress,
    phase: 'discover-and-authenticate',
  });

  try {
    const payload = await sendPopupMessage({
      action: 'addAccount',
      userAddress,
    });
    elements.userAddress.value = '';
    renderAccounts(payload);
    setStatus('ready', 'Account authenticated', `${userAddress} is now stored inside the extension and ready for brokered app connections.`, payload);
  } catch (error) {
    setStatus('error', 'Authentication failed', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});

elements.setActive.addEventListener('click', async () => {
  const accountId = elements.activeAccount.value || null;
  setBusy(true, 'Switching');
  setStatus('mutation', 'Switching active account', 'Updating which stored identity will be offered to apps by default.');

  try {
    const payload = await sendPopupMessage({
      action: 'setActiveAccount',
      accountId,
    });
    renderAccounts(payload);
    const activeAccount = payload.accounts.find((account) => account.active);
    setStatus(
      'ready',
      activeAccount ? 'Active account updated' : 'No active account selected',
      activeAccount
        ? `${activeAccount.userAddress} will now be offered first to compatible apps.`
        : 'Compatible apps will need to specify a matching account until you choose a default again.',
      payload,
    );
  } catch (error) {
    setStatus('error', 'Could not switch active account', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});

refreshAccounts({ warm: true }).catch((error) => {
  document.body.classList.add('loaded');
  document.body.classList.remove('loading');
  setStatus('error', 'Could not restore cached state', error instanceof Error ? error.message : String(error));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  if (!changes[STORAGE_KEYS.accounts] && !changes[STORAGE_KEYS.activeAccountId]) {
    return;
  }

  refreshAccounts().catch((error) => {
    setStatus('error', 'Cache refresh failed', error instanceof Error ? error.message : String(error));
  });
});
