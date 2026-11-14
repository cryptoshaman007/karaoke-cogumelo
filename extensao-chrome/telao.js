// Bridge between the projector page and the extension. The page talks with window.postMessage.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const toPage = (msg) => window.postMessage({ source: 'karaoke-ext', version: VERSION, ...msg }, location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (!m || m.source !== 'karaoke-page') return;
    if (m.type === 'hello') return toPage({ type: 'ready' });
    if (m.type === 'open' || m.type === 'close' || m.type === 'cmd') {
      try {
        chrome.runtime.sendMessage(m).catch(() => toPage({ type: 'error', reason: 'extension' }));
      } catch {
        // the extension was reloaded or removed: this page must fall back to the manual way
        toPage({ type: 'gone' });
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && typeof msg === 'object') toPage(msg);
  });

  toPage({ type: 'ready' });
})();
