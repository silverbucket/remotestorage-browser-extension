const RemoteStorage = window.RemoteStorage;
const NOTE_PATH = '/notes/demo.txt';

if (!RemoteStorage) {
  throw new Error('Missing window.RemoteStorage. Run the bundle sync script first.');
}

const elements = {
  backendStatus: document.querySelector('#backend-status'),
  checkExtension: document.querySelector('#check-extension'),
  connectButton: document.querySelector('#connect-button'),
  connectionStatus: document.querySelector('#connection-status'),
  deleteButton: document.querySelector('#delete-button'),
  extensionStatus: document.querySelector('#extension-status'),
  getButton: document.querySelector('#get-button'),
  noteBody: document.querySelector('#note-body'),
  output: document.querySelector('#output'),
  putButton: document.querySelector('#put-button'),
  remoteStatus: document.querySelector('#remote-status'),
  scopeInput: document.querySelector('#scope-input'),
  userAddress: document.querySelector('#user-address')
};

const rs = new RemoteStorage({ cache: false, logging: true });
let activeExtensionAccount = null;

function setOutput(value) {
  elements.output.textContent = typeof value === 'string'
    ? value
    : JSON.stringify(value, null, 2);
}

function updateExtensionStatus() {
  const provider = window.remoteStorageExtension;
  if (!provider) {
    elements.extensionStatus.textContent = 'not detected';
    return;
  }

  elements.extensionStatus.textContent = `detected (v${provider.version})`;
}

function syncUserAddressFromPing(result) {
  const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
  activeExtensionAccount = accounts.find((account) => {
    return account.active || account.accountId === result?.activeAccountId;
  });

  if (activeExtensionAccount && !elements.userAddress.value.trim()) {
    elements.userAddress.placeholder = `Leave blank to use ${activeExtensionAccount.userAddress}`;
  }
}

function updateConnectionStatus(status) {
  elements.connectionStatus.textContent = status;
  elements.backendStatus.textContent = rs.backend || 'unknown';
  if (rs.remote?.sessionId) {
    elements.remoteStatus.textContent = 'extension transport';
  } else {
    elements.remoteStatus.textContent = rs.remote?.constructor?.name || 'unknown';
  }
}

function applyScope(scopeString) {
  rs.access.reset();
  scopeString
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean)
    .forEach((scopeEntry) => {
      const parts = scopeEntry.split(':');
      if (parts.length !== 2) {
        throw new Error(`Invalid scope "${scopeEntry}"`);
      }
      rs.access.claim(parts[0], parts[1]);
    });
}

rs.on('connected', () => {
  updateConnectionStatus('connected');
  setOutput({
    event: 'connected',
    backend: rs.backend,
    remoteType: rs.remote?.sessionId ? 'extension transport' : rs.remote?.constructor?.name,
    userAddress: rs.remote?.userAddress,
    href: rs.remote?.href
  });
});

rs.on('not-connected', () => {
  updateConnectionStatus('not-connected');
});

rs.on('error', (error) => {
  updateConnectionStatus(`error: ${error.name}`);
  setOutput({
    error: error.name,
    code: error.code,
    message: error.message
  });
});

elements.checkExtension.addEventListener('click', async () => {
  updateExtensionStatus();

  if (!window.remoteStorageExtension) {
    setOutput('No window.remoteStorageExtension provider detected.');
    return;
  }

  try {
    const result = await window.remoteStorageExtension.ping();
    syncUserAddressFromPing(result);
    setOutput(result);
  } catch (error) {
    setOutput(error instanceof Error ? error.message : String(error));
  }
});

elements.connectButton.addEventListener('click', async () => {
  updateExtensionStatus();
  updateConnectionStatus('connecting');

  try {
    applyScope(elements.scopeInput.value);
    const userAddress = elements.userAddress.value.trim();
    if (userAddress) {
      rs.connect(userAddress);
    } else {
      rs.connect();
    }
    setOutput({
      action: 'connect',
      userAddress: userAddress || activeExtensionAccount?.userAddress || '(extension active account)',
      requestedScope: elements.scopeInput.value
    });
  } catch (error) {
    setOutput(error instanceof Error ? error.message : String(error));
  }
});

elements.putButton.addEventListener('click', async () => {
  try {
    const response = await rs.put(NOTE_PATH, elements.noteBody.value, 'text/plain; charset=UTF-8');
    setOutput({
      action: 'put',
      path: NOTE_PATH,
      response
    });
  } catch (error) {
    setOutput(error instanceof Error ? error.message : String(error));
  }
});

elements.getButton.addEventListener('click', async () => {
  try {
    const response = await rs.get(NOTE_PATH);
    setOutput({
      action: 'get',
      path: NOTE_PATH,
      response
    });
  } catch (error) {
    setOutput(error instanceof Error ? error.message : String(error));
  }
});

elements.deleteButton.addEventListener('click', async () => {
  try {
    const response = await rs.delete(NOTE_PATH);
    setOutput({
      action: 'delete',
      path: NOTE_PATH,
      response
    });
  } catch (error) {
    setOutput(error instanceof Error ? error.message : String(error));
  }
});

updateExtensionStatus();
updateConnectionStatus('idle');

if (window.remoteStorageExtension?.ping) {
  window.remoteStorageExtension.ping()
    .then((result) => {
      syncUserAddressFromPing(result);
    })
    .catch(() => undefined);
}
