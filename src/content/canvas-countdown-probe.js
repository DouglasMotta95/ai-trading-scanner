(() => {
  if (globalThis.__ATS_CANVAS_COUNTDOWN_PROBE__) return;
  globalThis.__ATS_CANVAS_COUNTDOWN_PROBE__ = true;

  const casa = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');
  const trader = value => value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  let ref = '';
  try { ref = new URL(document.referrer || '').hostname.toLowerCase().replace(/\.$/, ''); } catch {}
  const opaque = ['blob:', 'about:', 'data:'].includes(String(location.protocol || '').toLowerCase());
  if (!casa(host) && !trader(host) && !casa(ref) && !trader(ref) && !opaque) return;

  let lastKey = '';
  let lastAt = 0;
  function parse(value) {
    const text = String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
    const match = text.match(/^(\d{1,2}):([0-5]\d)$/);
    if (!match) return null;
    const seconds = Number(match[1]) * 60 + Number(match[2]);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3600) return null;
    return { text, seconds };
  }
  function publish(parsed, x, y) {
    const now = Date.now();
    const key = `${parsed.text}|${Math.round(Number(x) || 0)}|${Math.round(Number(y) || 0)}`;
    if (key === lastKey && now - lastAt < 450) return;
    lastKey = key; lastAt = now;
    try {
      window.postMessage({
        source: 'ATS_CANVAS_CANDLE_COUNTDOWN',
        payload: { seconds: parsed.seconds, text: parsed.text, x: Number(x) || null, y: Number(y) || null, at: now }
      }, '*');
    } catch {}
  }
  function hook(proto) {
    if (!proto || proto.__atsCanvasCountdownHooked) return;
    try { Object.defineProperty(proto, '__atsCanvasCountdownHooked', { value: true }); } catch { return; }
    for (const name of ['fillText', 'strokeText']) {
      const native = proto[name];
      if (typeof native !== 'function') continue;
      proto[name] = function(value, x, y, ...rest) {
        try {
          const parsed = parse(value);
          if (parsed) publish(parsed, x, y);
        } catch {}
        return native.call(this, value, x, y, ...rest);
      };
    }
  }
  try { hook(window.CanvasRenderingContext2D?.prototype); } catch {}
  try { hook(window.OffscreenCanvasRenderingContext2D?.prototype); } catch {}
})();
