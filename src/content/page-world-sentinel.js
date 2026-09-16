(() => {
  if (window.__ATS_PAGE_WORLD_SENTINEL__) return;
  window.__ATS_PAGE_WORLD_SENTINEL__ = true;
  try {
    window.postMessage({ source: 'ATS_PAGE_WORLD_SENTINEL', type: 'boot', at: Date.now() }, '*');
  } catch {}
})();
