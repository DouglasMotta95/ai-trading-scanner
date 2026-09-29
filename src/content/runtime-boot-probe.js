(() => {
  if (globalThis.__ATS_RUNTIME_BOOT_PROBE__) return;
  globalThis.__ATS_RUNTIME_BOOT_PROBE__ = true;

  const cleanHost = value => String(value || '').toLowerCase().replace(/\.$/, '').slice(0, 120);
  const describe = value => {
    try {
      const url = new URL(String(value || ''), location.href);
      return {
        protocol: String(url.protocol || '').slice(0, 16),
        host: cleanHost(url.hostname),
        opaque: ['blob:', 'about:', 'data:'].includes(String(url.protocol || '').toLowerCase()),
        srcdoc: false
      };
    } catch {
      return { protocol: '', host: '', opaque: false, srcdoc: false };
    }
  };
  const referrerHost = () => {
    try { return cleanHost(new URL(document.referrer || '').hostname); } catch { return ''; }
  };
  const frameHints = () => {
    if (window !== window.top) return [];
    const out = [];
    for (const frame of [...document.querySelectorAll('iframe')].slice(0, 16)) {
      const srcdoc = frame.hasAttribute('srcdoc');
      const row = describe(frame.getAttribute('src') || 'about:blank');
      row.srcdoc = srcdoc;
      out.push(row);
    }
    return out;
  };
  const send = phase => {
    const runtime = globalThis.chrome?.runtime;
    if (!runtime || typeof runtime.sendMessage !== 'function') return;
    const boot = {
      module: 'runtime-boot-probe',
      phase,
      protocol: String(location.protocol || '').slice(0, 16),
      host: cleanHost(location.hostname),
      referrerHost: referrerHost(),
      isTop: window === window.top,
      readyState: String(document.readyState || '').slice(0, 24),
      frameHints: frameHints()
    };
    try { runtime.sendMessage({ type: 'ATS_RUNTIME_BOOT', boot }, () => { try { void runtime.lastError; } catch {} }); } catch {}
  };

  send('start');
  setTimeout(() => send('settled-1200'), 1200);
  setTimeout(() => send('settled-3500'), 3500);
})();
