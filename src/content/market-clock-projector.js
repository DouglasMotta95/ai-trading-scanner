(() => {
  if (globalThis.__ATS_MARKET_CLOCK_PROJECTOR__) return;
  globalThis.__ATS_MARKET_CLOCK_PROJECTOR__ = true;

  const sendMessage = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof sendMessage !== 'function') return;
  const host = String(location.hostname || '').toLowerCase().replace(/\.$/, '');
  const allowed = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io') || value === 'casatraders.online' || value.endsWith('.casatraders.online') || value === 'ivcasatraders.online' || value.endsWith('.ivcasatraders.online');
  if (!allowed(host)) return;

  const clean = value => String(value ?? '').trim();
  const marketId = value => clean(value).toUpperCase().replace(/\s+/g, ' ');
  const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);
  function tfSeconds(value = '') {
    const raw = clean(value).toUpperCase().replace(/\s+/g, '');
    let m = raw.match(/^S(\d{1,5})$/); if (m) return Number(m[1]);
    m = raw.match(/^M(\d{1,4})$/); if (m) return Number(m[1]) * 60;
    m = raw.match(/^H(\d{1,3})$/); if (m) return Number(m[1]) * 3600;
    return null;
  }

  let anchor = null;
  let busy = false;
  let lastSentSecond = null;

  function canAnchor(state = {}, clock = {}, focus = {}) {
    if (state.connection !== 'online' || !state.asset || !sameMarket(state.asset, focus.asset)) return false;
    if (focus.reliable !== true || focus.chartScoped !== true || focus.trustedChartFrame !== true) return false;
    if (String(focus.frameHost || '').toLowerCase() !== host) return false;
    if (clock.verified !== true || clock.available === false || clock.role !== 'candle-close') return false;
    if (!['network-server-cycle', 'trader-dom-countdown'].includes(String(clock.source || ''))) return false;
    if (!sameMarket(clock.asset, state.asset) || Number(clock.frameId) !== Number(focus.frameId)) return false;
    const duration = tfSeconds(clock.timeframe || state.analysisTimeframe || state.timeframe);
    const seconds = Number(clock.secondsRemaining);
    const at = Number(clock.at || 0);
    if (!duration || !Number.isFinite(seconds) || seconds < 0 || seconds > duration + 2 || !at) return false;
    if (Date.now() - at > 2600 && String(clock.mode || '') !== 'exact-local-projector') return false;
    return true;
  }

  function refreshAnchor(state = {}) {
    const clock = state.diagnostics?.marketClock || {};
    const focus = state.diagnostics?.focusedAsset || {};
    if (!canAnchor(state, clock, focus)) return;
    const key = `${marketId(state.asset)}|${clean(clock.timeframe || state.analysisTimeframe || state.timeframe)}|${Number(focus.frameId)}|${String(clock.source || '')}`;
    if (String(clock.mode || '') === 'exact-local-projector' && anchor?.key === key) return;
    const seconds = Number(clock.secondsRemaining);
    anchor = {
      key,
      asset: state.asset,
      timeframe: clock.timeframe || state.analysisTimeframe || state.timeframe,
      frameId: Number(focus.frameId),
      frameHost: host,
      source: String(clock.source || 'network-server-cycle'),
      expiration: state.platformControls?.observed?.expiration || state.targetExpiration || state.expiration || null,
      closeAt: Number(clock.at) + Math.max(0, seconds) * 1000,
      confidence: Math.max(90, Number(clock.confidence || 0))
    };
    lastSentSecond = null;
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const reply = await sendMessage({ type: 'ATS_READ_SCANNER_STATE' });
      const state = reply?.state || {};
      refreshAnchor(state);
      if (!anchor) return;
      if (!sameMarket(state.asset, anchor.asset)) { anchor = null; return; }
      const duration = tfSeconds(anchor.timeframe);
      if (!duration) { anchor = null; return; }
      const remaining = Math.max(0, Math.min(duration, Math.ceil((anchor.closeAt - Date.now()) / 1000)));
      if (remaining <= 0) {
        anchor = null;
        lastSentSecond = null;
        return;
      }
      if (remaining === lastSentSecond) return;
      lastSentSecond = remaining;
      await sendMessage({
        type: 'ATS_MARKET_CLOCK_V2',
        asset: anchor.asset,
        timeframe: anchor.timeframe,
        secondsRemaining: remaining,
        expiration: anchor.expiration,
        available: true,
        verified: true,
        operational: true,
        clockRole: 'candle-close',
        clockSource: anchor.source,
        clockMode: 'exact-local-projector',
        clockText: `Fechamento real da vela • ${remaining}s`,
        clockToken: `${remaining}s`,
        confidence: anchor.confidence,
        frameHost: anchor.frameHost,
        at: Date.now()
      });
    } finally {
      busy = false;
    }
  }

  setInterval(() => tick().catch(() => {}), 300);
  tick().catch(() => {});
})();
