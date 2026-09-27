(() => {
  if (globalThis.__ATS_MARKET_CLOCK_PROJECTOR__) return;
  globalThis.__ATS_MARKET_CLOCK_PROJECTOR__ = true;

  // Disabled by design: M1 decision timing must come only from an exact
  // CasaTrade observation (trader-dom-countdown / network-server-cycle).
  // Do not locally project/decrement the last known second and do not publish
  // ATS_MARKET_CLOCK_V2 from a browser timer.
  globalThis.__ATS_MARKET_CLOCK_PROJECTOR_STATUS__ = {
    enabled: false,
    reason: 'authoritative-casatrade-clock-only',
    at: Date.now()
  };
})();