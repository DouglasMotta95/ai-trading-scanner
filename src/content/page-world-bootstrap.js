(() => {
  if (globalThis.__ATS_PAGE_WORLD_BOOTSTRAP__) return;
  globalThis.__ATS_PAGE_WORLD_BOOTSTRAP__ = true;

  const FILES = [
    'src/content/page-world-sentinel.js',
    'src/content/standalone-instrument-probe.js',
    'src/content/worker-probe.js',
    'src/content/canvas-probe.js',
    'src/content/network-probe.js'
  ];

  const runtime = globalThis.chrome?.runtime;
  const cleanHost = value => String(value || '').toLowerCase().replace(/\.$/, '').slice(0, 120);
  const sendBoot = phase => {
    if (!runtime || typeof runtime.sendMessage !== 'function') return;
    const boot = {
      module: 'page-world-bootstrap',
      phase,
      protocol: String(location.protocol || '').slice(0, 16),
      host: cleanHost(location.hostname),
      isTop: window === window.top,
      readyState: String(document.readyState || '').slice(0, 24),
      frameHints: []
    };
    try { runtime.sendMessage({ type: 'ATS_RUNTIME_BOOT', boot }, () => { try { void runtime.lastError; } catch {} }); } catch {}
  };

  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== 'ATS_PAGE_WORLD_SENTINEL' || event.data?.type !== 'boot') return;
    sendBoot('page-world-confirmed');
  }, true);

  const mount = () => {
    const root = document.documentElement || document.head || document.body;
    if (!root || !runtime?.getURL) {
      setTimeout(mount, 50);
      return;
    }
    sendBoot('bootstrap-start');
    for (const file of FILES) {
      const marker = `ats-${file.split('/').pop().replace(/[^a-z0-9]/gi, '-')}`;
      if (document.querySelector(`script[data-${marker}]`)) continue;
      try {
        const script = document.createElement('script');
        script.src = runtime.getURL(file);
        script.async = false;
        script.setAttribute(`data-${marker}`, '1');
        script.addEventListener('error', () => sendBoot(`load-error:${file.split('/').pop()}`), { once: true });
        root.appendChild(script);
      } catch {}
    }
    sendBoot('bootstrap-scheduled');
  };

  mount();
})();
