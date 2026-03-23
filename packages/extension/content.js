const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.async = false;
(document.head || document.documentElement).appendChild(script);
script.remove();

window.addEventListener('message', async (event) => {
  if (event.source !== window || !event.data) {
    return;
  }
  if (event.data.direction !== 'page-to-extension') {
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'rs-extension-bridge',
      id: event.data.id,
      method: event.data.method,
      payload: event.data.payload
    });

    window.postMessage({
      id: event.data.id,
      direction: 'extension-to-page',
      method: event.data.method,
      payload: response?.payload,
      error: response?.error
    }, window.location.origin);
  } catch (error) {
    window.postMessage({
      id: event.data.id,
      direction: 'extension-to-page',
      method: event.data.method,
      error: {
        code: 'request_failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }, window.location.origin);
  }
});
