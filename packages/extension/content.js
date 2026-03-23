const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.async = false;
(document.head || document.documentElement).appendChild(script);
script.remove();

document.addEventListener('remotestorage-bridge', async (event) => {
  const detail = event.detail;
  if (!detail || detail.direction !== 'page-to-extension') {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'rs-extension-bridge',
      id: detail.id,
      method: detail.method,
      payload: detail.payload,
    });

    document.dispatchEvent(new CustomEvent('remotestorage-bridge', {
      detail: {
        id: detail.id,
        direction: 'extension-to-page',
        method: detail.method,
        payload: response?.payload,
        error: response?.error,
      },
    }));
  } catch (error) {
    document.dispatchEvent(new CustomEvent('remotestorage-bridge', {
      detail: {
        id: detail.id,
        direction: 'extension-to-page',
        method: detail.method,
        error: {
          code: 'request_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      },
    }));
  }
});
