(() => {
  if (globalThis.__ATS_ASSET_OBSERVER__) return;
  globalThis.__ATS_ASSET_OBSERVER__ = true;
  const send = globalThis.__ATS_SEND_MESSAGE__;
  if (typeof send !== 'function') return;
  const clean = v => String(v ?? '').normalize('NFKC').replace(/\s+/g,' ').trim();
  const pair = v => {
    const raw = clean(v).toUpperCase();
    const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
    const m = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
    return m ? `${m[1]}/${m[2]}${otc ? ' (OTC)' : ''}` : '';
  };
  const visible = el => {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    return r.width > 10 && r.height > 8 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
  };
  const text = el => clean([el?.textContent,el?.getAttribute?.('aria-label'),el?.getAttribute?.('title'),el?.getAttribute?.('data-symbol'),el?.getAttribute?.('data-asset')].filter(Boolean).join(' '));
  let last = '', samples = 0, timer = null;
  function publish(asset, explicit = false, source = 'semantic-selected') {
    if (!asset) return;
    if (asset === last) samples += 1; else { last = asset; samples = 1; }
    if (!explicit && samples < 2) return;
    send({ type:'ATS_VISUAL_FOCUS_V2', asset, reliable:true, chartScoped:true, visual:true, explicit, score: explicit ? 100 : 85, samples, frameRole: location.hostname.includes('casatraders') ? 'trader-frame' : 'casa-chart-frame', source }).catch(()=>{});
  }
  function selectedCandidate() {
    const selectors = ['[aria-selected="true"]','[aria-current="true"]','[role="tab"][aria-selected="true"]','[data-selected="true"]','.active','.selected'];
    for (const el of document.querySelectorAll(selectors.join(','))) {
      if (!visible(el)) continue;
      const asset = pair(text(el));
      if (asset) return asset;
    }
    const heads = [...document.querySelectorAll('header,[role="heading"],h1,h2,h3,[data-testid*="symbol" i],[data-testid*="asset" i]')].filter(visible);
    for (const el of heads) { const asset = pair(text(el)); if (asset) return asset; }
    return '';
  }
  function scan() { publish(selectedCandidate(), false); }
  function schedule() { if (timer) return; timer = setTimeout(()=>{timer=null;scan();},90); }
  document.addEventListener('pointerup', event => {
    const path = event.composedPath?.() || [event.target];
    for (const node of path) {
      if (!(node instanceof Element) || !visible(node)) continue;
      const asset = pair(text(node));
      if (asset) { publish(asset,true,'user-selection'); break; }
    }
    setTimeout(scan,160); setTimeout(scan,420);
  }, true);
  new MutationObserver(schedule).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','aria-selected','aria-current','data-selected','data-symbol','data-asset']});
  window.addEventListener('popstate',schedule,true);
  window.addEventListener('hashchange',schedule,true);
  scan(); setTimeout(scan,500); setTimeout(scan,1500);
  setTimeout(function heartbeat(){ scan(); setTimeout(heartbeat,1500); },1500);
})();
