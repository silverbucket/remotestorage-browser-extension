const elements = {
  accounts: document.querySelector('#accounts'),
  accountsEmpty: document.querySelector('#accounts-empty'),
  accountsPanel: document.querySelector('#accounts-panel'),
  accountBadge: document.querySelector('#account-badge'),
  activeAccount: document.querySelector('#active-account'),
  activeSwitcher: document.querySelector('#active-switcher'),
  addAccount: document.querySelector('#add-account'),
  openOptions: document.querySelector('#open-options'),
  openSettings: document.querySelector('#open-settings'),
  setActive: document.querySelector('#set-active'),
  toast: document.querySelector('#toast'),
  userAddress: document.querySelector('#user-address'),
};

const STORAGE_KEYS = {
  accounts: 'accounts',
  activeAccountId: 'activeAccountId',
};

let toastTimer = null;

function showToast(kind, message) {
  clearTimeout(toastTimer);
  elements.toast.className = `toast visible toast-${kind}`;
  elements.toast.textContent = message;
  if (kind !== 'error') {
    toastTimer = setTimeout(() => {
      elements.toast.classList.remove('visible');
    }, 4000);
  }
}

function hideToast() {
  clearTimeout(toastTimer);
  elements.toast.classList.remove('visible');
}

function setBusy(isBusy) {
  document.body.classList.toggle('busy', isBusy);
  elements.addAccount.disabled = isBusy;
  elements.setActive.disabled = isBusy;
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

  return { accounts, activeAccountId };
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

function renderAccounts(state) {
  const accounts = state.accounts || [];

  // Badge
  elements.accountBadge.textContent = String(accounts.length);
  if (accounts.some((a) => a.active)) {
    elements.accountBadge.classList.add('badge-active');
  } else {
    elements.accountBadge.classList.remove('badge-active');
  }

  // Active account switcher
  elements.activeAccount.textContent = '';
  if (accounts.length > 1) {
    elements.activeSwitcher.style.display = '';
    accounts.forEach((account) => {
      const option = document.createElement('option');
      option.value = account.accountId;
      option.textContent = account.userAddress;
      option.selected = account.active;
      elements.activeAccount.appendChild(option);
    });
  } else {
    elements.activeSwitcher.style.display = 'none';
  }

  // Accounts list
  elements.accounts.textContent = '';

  if (accounts.length === 0) {
    elements.accountsEmpty.style.display = '';
    document.body.classList.add('loaded');
    document.body.classList.remove('loading');
    return;
  }

  elements.accountsEmpty.style.display = 'none';

  accounts.forEach((account) => {
    const li = document.createElement('li');
    li.className = 'account-card' + (account.active ? ' active' : '');

    const avatar = document.createElement('div');
    avatar.className = 'account-avatar';
    avatar.textContent = getInitial(account.userAddress);

    const info = document.createElement('div');
    info.className = 'account-info';

    const address = document.createElement('div');
    address.className = 'account-address';
    address.textContent = account.userAddress;

    const server = document.createElement('div');
    server.className = 'account-server';
    server.textContent = getServerHost(account.href);

    info.appendChild(address);
    info.appendChild(server);

    const actions = document.createElement('div');
    actions.className = 'account-actions';

    if (account.active) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-active';
      badge.textContent = 'Active';
      badge.style.marginRight = '4px';
      actions.appendChild(badge);
    }

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      setBusy(true);
      try {
        const payload = await sendPopupMessage({
          action: 'removeAccount',
          accountId: account.accountId,
        });
        renderAccounts(payload);
        showToast('success', 'Account removed');
      } catch (error) {
        showToast('error', error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    });
    actions.appendChild(removeBtn);

    li.appendChild(avatar);
    li.appendChild(info);
    li.appendChild(actions);
    elements.accounts.appendChild(li);
  });

  document.body.classList.add('loaded');
  document.body.classList.remove('loading');
}

async function refreshAccounts() {
  const payload = await readStoredState();
  renderAccounts(payload);
}

// ── Event listeners ──

elements.addAccount.addEventListener('click', async () => {
  const userAddress = elements.userAddress.value.trim();
  if (!userAddress) {
    showToast('error', 'Enter a remoteStorage address (e.g. user@example.com)');
    elements.userAddress.focus();
    return;
  }

  hideToast();
  setBusy(true);

  try {
    const payload = await sendPopupMessage({
      action: 'addAccount',
      userAddress,
    });
    elements.userAddress.value = '';
    renderAccounts(payload);
    showToast('success', `Added ${userAddress}`);
  } catch (error) {
    showToast('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});

elements.userAddress.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    elements.addAccount.click();
  }
});

elements.setActive.addEventListener('click', async () => {
  const accountId = elements.activeAccount.value || null;
  setBusy(true);

  try {
    const payload = await sendPopupMessage({
      action: 'setActiveAccount',
      accountId,
    });
    renderAccounts(payload);
    showToast('success', 'Active account updated');
  } catch (error) {
    showToast('error', error instanceof Error ? error.message : String(error));
  } finally {
    setBusy(false);
  }
});

function openOptionsPage() {
  chrome.runtime.openOptionsPage();
}

elements.openOptions.addEventListener('click', openOptionsPage);
elements.openSettings.addEventListener('click', (e) => {
  e.preventDefault();
  openOptionsPage();
});

// ── Init ──

refreshAccounts().catch((error) => {
  document.body.classList.add('loaded');
  document.body.classList.remove('loading');
  showToast('error', error instanceof Error ? error.message : String(error));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes[STORAGE_KEYS.accounts] && !changes[STORAGE_KEYS.activeAccountId]) return;
  refreshAccounts().catch((error) => {
    showToast('error', error instanceof Error ? error.message : String(error));
  });
});
