(() => {
  if (globalThis.__ATS_SNIPER_PAGE_BOOTSTRAP__) return;
  globalThis.__ATS_SNIPER_PAGE_BOOTSTRAP__ = true;

  const files = [
    'src/content/page-world-sentinel.js',
    'src/content/standalone-instrument-probe.js',
    'src/content/worker-probe.js',
    'src/content/network-probe.js'
  ];
  const runtime = globalThis.chrome?.runtime;
  const cleanHost = value => String(value || '').toLowerCase().replace(/\.$/, '').slice(0, 120);

  const report = phase => {
    if (!runtime || typeof runtime.sendMessage !== 'function') return;
    const boot = {
      module: 'sniper-page-bootstrap',
      phase,
      protocol: String(location.protocol || '').slice(0, 16),
      host: cleanHost(location.hostname),
      isTop: window === window.top,
      readyState: String(document.readyState || '').slice(0, 24),
      frameHints: []
    };
    try {
      runtime.sendMessage({ type: 'ATS_RUNTIME_BOOT', boot }, () => {
        try { void runtime.lastError; } catch {}
      });
    } catch {}
  };

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'ATS_PAGE_WORLD_SENTINEL' || event.data?.type !== 'boot') return;
    report('page-world-confirmed');
  }, true);

  function mount() {
    const root = document.documentElement || document.head || document.body;
    if (!root || !runtime?.getURL) {
      setTimeout(mount, 50);
      return;
    }

    report('bootstrap-start');
    for (const file of files) {
      const key = `ats-sniper-${file.split('/').pop()}`;
      if (document.querySelector(`script[data-ats-sniper-file="${key}"]`)) continue;
      try {
        const script = document.createElement('script');
        script.src = runtime.getURL(file);
        script.async = false;
        script.dataset.atsSniperFile = key;
        script.addEventListener('error', () => report(`load-error:${file.split('/').pop()}`), { once: true });
        root.appendChild(script);
      } catch {
        report(`mount-error:${file.split('/').pop()}`);
      }
    }
    report('bootstrap-scheduled');
  }

  mount();
})();
