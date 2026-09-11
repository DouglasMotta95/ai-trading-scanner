(() => {
  const PRICE_RE = /(?:^|\s)(\d{1,6}[.,]\d{2,6})(?:\s|$)/;
  const ASSET_RE = /\b(?:EUR|USD|GBP|JPY|AUD|CAD|CHF|NZD|BTC|ETH)[\s\/-]?(?:USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD)\b/i;
  const TF_RE = /\b(?:M1|M5|M15|M30|H1|H4|D1|1m|5m|15m|30m|1h|4h)\b/i;

  function visibleText() {
    return (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 120000);
  }

  function normalizeAsset(value) {
    return value ? value.toUpperCase().replace(/\s/g, '').replace('-', '/') : null;
  }

  function inspect() {
    const text = visibleText();
    const asset = text.match(ASSET_RE)?.[0] || null;
    const timeframe = text.match(TF_RE)?.[0] || null;
    const prices = [];
    const nodes = document.querySelectorAll('span,div,strong,b,p');
    for (const node of nodes) {
      const value = (node.textContent || '').trim();
      const match = value.match(PRICE_RE);
      if (match && value.length < 30) prices.push(match[1]);
      if (prices.length >= 8) break;
    }

    const chartCandidates = document.querySelectorAll('canvas,svg,[class*="chart" i],[id*="chart" i]').length;
    const snapshot = {
      url: location.origin + location.pathname,
      asset: normalizeAsset(asset),
      timeframe,
      price: prices[0] || null,
      diagnostics: {
        domNodes: document.getElementsByTagName('*').length,
        canvases: document.querySelectorAll('canvas').length,
        svgs: document.querySelectorAll('svg').length,
        chartCandidates,
        priceCandidates: prices.length
      }
    };
    chrome.runtime.sendMessage({ type: 'ATS_PLATFORM_SNAPSHOT', payload: snapshot }).catch(() => {});
  }

  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(inspect, 350);
  };

  new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  window.addEventListener('load', inspect, { once: true });
  setInterval(inspect, 2500);
})();
