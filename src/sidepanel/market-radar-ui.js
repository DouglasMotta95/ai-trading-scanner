// Read-only pre-operation radar: never mutates the technical signal engine or CasaTrade controls.
const STATE_KEY = 'scannerState';
const PREF_KEY = 'atsMarketRadarPreferencesV1';
const ASSET_RADAR_KEY = 'atsAssetRadarV1';
const clean = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));

let lastState = {};
let assetRadarSnapshot = { rows: [] };
let liveEnabled = true;
let lastRadarSignature = '';
let lastRenderedAt = 0;

function marketId(value) {
  const raw = clean(value).toUpperCase();
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/i.test(raw);
  const pair = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/i);
  return pair ? `${pair[1]}/${pair[2]}${otc ? ' (OTC)' : ''}` : raw;
}

function timestamp(row = {}) {
  let value = num(row.time ?? row.timestamp ?? row.openTime ?? row.startedAt);
  if (value != null && value > 0 && value < 1e12) value *= 1000;
  return value != null && value > 0 ? value : null;
}

function completeRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => ({
      ...row,
      time: timestamp(row),
      open: num(row.open),
      high: num(row.high),
      low: num(row.low),
      close: num(row.close)
    }))
    .filter(row => row.time != null && [row.open,row.high,row.low,row.close].every(v => v != null))
    .sort((a,b) => a.time - b.time);
}

function median(values = []) {
  const rows = values.filter(Number.isFinite).sort((a,b) => a-b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function inferTfMs(rows = []) {
  const ordered = completeRows(rows);
  const diffs = [];
  for (let i = 1; i < ordered.length; i++) {
    const diff = ordered[i].time - ordered[i - 1].time;
    if (diff >= 30_000 && diff <= 600_000) diffs.push(diff);
  }
  const med = median(diffs);
  if (med == null) return null;
  if (med >= 240_000) return 300_000;
  if (med >= 45_000 && med <= 90_000) return 60_000;
  return med;
}

function aggregateM5(rows = []) {
  const source = completeRows(rows);
  if (source.length < 5) return [];
  const groups = new Map();
  for (const row of source) {
    const bucket = Math.floor(row.time / 300_000) * 300_000;
    const current = groups.get(bucket) || [];
    current.push(row);
    groups.set(bucket, current);
  }
  return [...groups.entries()]
    .sort((a,b) => a[0] - b[0])
    .filter(([,group]) => group.length >= 4)
    .map(([time, group]) => ({
      time,
      open: group[0].open,
      high: Math.max(...group.map(row => row.high)),
      low: Math.min(...group.map(row => row.low)),
      close: group[group.length - 1].close
    }));
}

function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function assess(rows = [], timeframe = 'M1') {
  const candles = completeRows(rows).slice(-18);
  if (candles.length < 6) {
    return { timeframe, quality: 0, state: 'INSUFFICIENT', direction: null, reasons: ['histórico real insuficiente'] };
  }

  const bodies = candles.map(c => Math.abs(c.close - c.open));
  const ranges = candles.map(c => Math.max(1e-12, c.high - c.low));
  const closes = candles.map(c => c.close);
  const deltas = closes.slice(1).map((close, i) => close - closes[i]);
  const net = closes.at(-1) - closes[0];
  const activity = deltas.reduce((sum, value) => sum + Math.abs(value), 0);
  const avgRange = Math.max(1e-12, mean(ranges.slice(-10)));
  const avgBody = Math.max(1e-12, mean(bodies.slice(-10, -1)));
  const direction = net > 0 ? 'BUY' : net < 0 ? 'SELL' : null;
  const consistency = activity > 0 ? Math.abs(net) / activity : 0;
  const displacement = Math.min(1, Math.abs(net) / (avgRange * Math.max(1, candles.length - 1)));
  const last = candles.at(-1);
  const previous = candles.at(-2);
  const lastBody = Math.abs(last.close - last.open);
  const extension = lastBody / avgBody;
  const lastRange = Math.max(1e-12, last.high - last.low);
  const upperWick = (last.high - Math.max(last.open, last.close)) / lastRange;
  const lowerWick = (Math.min(last.open, last.close) - last.low) / lastRange;
  const oppositeWick = direction === 'BUY' ? upperWick : direction === 'SELL' ? lowerWick : Math.max(upperWick, lowerWick);

  const recent = candles.slice(-8);
  const recentHigh = Math.max(...recent.slice(0, -1).map(c => c.high));
  const recentLow = Math.min(...recent.slice(0, -1).map(c => c.low));
  const room = direction === 'BUY'
    ? Math.max(0, recentHigh - last.close) / avgRange
    : direction === 'SELL'
      ? Math.max(0, last.close - recentLow) / avgRange
      : 0;

  const sameDirection = direction
    ? recent.slice(-5).filter(c => (c.close > c.open ? 'BUY' : c.close < c.open ? 'SELL' : null) === direction).length / Math.min(5, recent.length)
    : 0;

  let quality = 34;
  quality += consistency * 22;
  quality += displacement * 18;
  quality += sameDirection * 18;
  quality += Math.min(1.5, room) / 1.5 * 12;

  const reasons = [];
  if (consistency >= .62) reasons.push('movimento consistente');
  else if (consistency <= .35) reasons.push('movimento ruidoso');

  if (extension >= 1.8) {
    quality -= 18;
    reasons.push('última vela muito esticada');
  } else if (extension >= 1.4) {
    quality -= 9;
    reasons.push('impulso já avançado');
  }

  if (oppositeWick >= .38) {
    quality -= 12;
    reasons.push('rejeição contrária relevante');
  }

  if (room < .35) {
    quality -= 14;
    reasons.push(direction === 'BUY' ? 'pouco espaço até topo recente' : direction === 'SELL' ? 'pouco espaço até fundo recente' : 'sem direção limpa');
  } else if (room >= .8) {
    reasons.push('bom espaço para continuidade');
  }

  const previousDirection = previous.close > previous.open ? 'BUY' : previous.close < previous.open ? 'SELL' : null;
  const lastDirection = last.close > last.open ? 'BUY' : last.close < last.open ? 'SELL' : null;
  if (direction && previousDirection === direction && lastDirection !== direction && lastBody >= avgBody * 1.1) {
    quality -= 10;
    reasons.push('reversão recente contra a tendência');
  }

  quality = Math.round(clamp(quality));
  const state = quality >= 68 ? 'FAVORABLE' : quality >= 55 ? 'WATCH' : 'WAIT';
  return { timeframe, quality, state, direction, reasons: reasons.slice(0, 3), candles: candles.length };
}

function histories(state = {}) {
  const byAsset = new Map();
  const put = (asset, rows) => {
    const id = marketId(asset);
    const normalized = completeRows(rows);
    if (!id || normalized.length < 6) return;
    const previous = byAsset.get(id);
    if (!previous || normalized.length > previous.rows.length || Number(normalized.at(-1)?.time || 0) > Number(previous.rows.at(-1)?.time || 0)) {
      byAsset.set(id, { asset: id, rows: normalized });
    }
  };

  const history = state.marketHistory && typeof state.marketHistory === 'object' ? state.marketHistory : {};
  for (const [asset, rows] of Object.entries(history)) put(asset, rows);

  const currentAsset = marketId(state.asset);
  put(currentAsset, state.candles);

  // The existing passive CasaTrade asset radar observes other markets from the
  // platform feed. Use only rows that actually contain captured candles.
  for (const row of Array.isArray(assetRadarSnapshot?.rows) ? assetRadarSnapshot.rows : []) {
    put(row?.asset, row?.candles);
  }

  return [...byAsset.values()];
}

function analyzeAsset(asset, rows, currentTf = '') {
  const tfMs = inferTfMs(rows);
  let m1Rows = [];
  let m5Rows = [];
  if (tfMs != null && tfMs >= 240_000) {
    m5Rows = rows;
  } else {
    m1Rows = rows;
    m5Rows = aggregateM5(rows);
  }

  const m1 = m1Rows.length >= 6 ? assess(m1Rows, 'M1') : { timeframe: 'M1', quality: 0, state: 'INSUFFICIENT', direction: null, reasons: ['sem M1 suficiente'] };
  const m5 = m5Rows.length >= 6 ? assess(m5Rows, 'M5') : { timeframe: 'M5', quality: 0, state: 'INSUFFICIENT', direction: null, reasons: ['sem M5 suficiente'] };

  const candidates = [m1,m5].filter(item => item.state !== 'INSUFFICIENT').sort((a,b) => b.quality - a.quality);
  const best = candidates[0] || null;
  const second = candidates[1] || null;
  const recommendation = !best || best.quality < 55
    ? 'AGUARDAR'
    : second && Math.abs(best.quality - second.quality) < 5 && best.quality < 68
      ? 'AGUARDAR'
      : best.timeframe;

  return {
    asset,
    m1,
    m5,
    recommendation,
    best,
    currentTf: clean(currentTf).toUpperCase()
  };
}

function scanMarket(state = {}) {
  const rows = histories(state);
  const currentTf = clean(state.analystPreferences?.operationMode || state.analysisTimeframe || state.timeframe || 'M1').toUpperCase();
  const analyses = rows.map(item => analyzeAsset(item.asset, item.rows, currentTf));
  analyses.sort((a,b) => (b.best?.quality || 0) - (a.best?.quality || 0));
  const current = analyses.find(item => item.asset === marketId(state.asset)) || null;
  return { analyses, current, currentTf, at: Date.now() };
}

function stateTone(value) {
  return value === 'FAVORABLE' ? 'good' : value === 'WATCH' ? 'watch' : 'wait';
}

function labelDirection(direction) {
  return direction === 'BUY' ? 'COMPRA' : direction === 'SELL' ? 'VENDA' : 'NEUTRO';
}

function ensureUi() {
  let root = document.getElementById('marketRadar');
  if (root) return root;
  const hero = document.querySelector('.market-hero');
  if (!hero) return null;

  const style = document.createElement('style');
  style.id = 'marketRadarStyle';
  style.textContent = `
    .market-radar{margin:10px 0;padding:13px;border:1px solid #1d4057;border-radius:16px;background:linear-gradient(180deg,#0a1a28,#07121d)}
    .market-radar-head,.market-radar-actions,.entry-check-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .market-radar-head small{color:#6f90a7;font-size:9px;letter-spacing:.07em}.market-radar-head b{font-size:13px}
    .market-radar-actions{margin-top:10px}.market-radar button{border:1px solid #2a5671;background:#0d2638;color:#dff4ff;border-radius:10px;padding:9px 11px;font-weight:800;font-size:10px}
    .market-radar button.primary{background:#12364b}.market-radar button.active{border-color:#58d2a8;color:#83edc8}
    .market-radar-summary{margin-top:10px;padding:10px;border-radius:12px;background:#0b1c2a;border:1px solid #17384e}
    .market-radar-summary strong{display:block;font-size:15px}.market-radar-summary p{margin:5px 0 0;color:#9db5c6;font-size:10px;line-height:1.45}
    .radar-tfs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:9px}.radar-tf{padding:9px;border-radius:11px;background:#081824;border:1px solid #173348}
    .radar-tf span{display:block;color:#6f8da2;font-size:9px}.radar-tf b{font-size:16px}.radar-tf.good b{color:#7ce5bf}.radar-tf.watch b{color:#f4cf76}.radar-tf.wait b{color:#d59a9a}
    .radar-opportunities{margin-top:9px;display:grid;gap:6px}.radar-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:8px;border-radius:10px;background:#081824}
    .radar-row span{font-size:10px}.radar-row small{color:#7693a6;font-size:9px}.radar-empty{color:#7791a4;font-size:10px;margin:10px 0 0}
    .entry-check{margin:10px 0;padding:12px;border-radius:14px;border:1px solid #66551f;background:#1b170a}
    .entry-check.danger{border-color:#7a3333;background:#210e0e}.entry-check strong{font-size:12px}.entry-check p{margin:6px 0 0;color:#d8c98c;font-size:10px;line-height:1.45}
    .entry-check.danger p{color:#f0abab}.entry-check .pill{font-size:9px;padding:4px 7px;border-radius:99px;border:1px solid currentColor}
  `;
  document.head.append(style);

  root = document.createElement('section');
  root.id = 'marketRadar';
  root.className = 'market-radar';
  root.innerHTML = `
    <div class="market-radar-head"><div><small>RADAR PRÉ-OPERAÇÃO</small><b>Melhor cenário para operar agora</b></div><span id="radarCoverage">0 ativos</span></div>
    <div class="market-radar-actions">
      <button id="runMarketRadar" class="primary" type="button">ANALISAR MERCADO AGORA</button>
      <button id="toggleMarketRadarLive" type="button">TEMPO REAL: ON</button>
    </div>
    <div id="radarSummary" class="market-radar-summary"><strong>AGUARDANDO DADOS</strong><p>O radar usa somente velas reais já capturadas pela extensão.</p></div>
    <div class="radar-tfs">
      <div id="radarM1" class="radar-tf wait"><span>M1</span><b>—</b><small>sem leitura</small></div>
      <div id="radarM5" class="radar-tf wait"><span>M5</span><b>—</b><small>sem leitura</small></div>
    </div>
    <div id="radarOpportunities" class="radar-opportunities"></div>
  `;
  hero.insertAdjacentElement('afterend', root);

  root.querySelector('#runMarketRadar')?.addEventListener('click', () => renderRadar(lastState, true));
  root.querySelector('#toggleMarketRadarLive')?.addEventListener('click', async () => {
    liveEnabled = !liveEnabled;
    await chrome.storage.local.set({ [PREF_KEY]: { liveEnabled } }).catch(() => {});
    syncLiveButton();
    if (liveEnabled) renderRadar(lastState, true);
  });
  return root;
}

function ensureEntryCheckUi() {
  let root = document.getElementById('entrySafetyCheck');
  if (root) return root;
  const card = document.getElementById('decisionCard');
  const actions = card?.querySelector('.trade-actions');
  if (!card || !actions) return null;
  root = document.createElement('div');
  root.id = 'entrySafetyCheck';
  root.className = 'entry-check';
  root.hidden = true;
  root.innerHTML = '<div class="entry-check-head"><strong>CONFIRA A CASATRADE ANTES DE ENTRAR</strong><span class="pill">MANUAL</span></div><p id="entrySafetyText"></p>';
  actions.insertAdjacentElement('beforebegin', root);
  return root;
}

function syncLiveButton() {
  const button = document.getElementById('toggleMarketRadarLive');
  if (!button) return;
  button.textContent = `TEMPO REAL: ${liveEnabled ? 'ON' : 'OFF'}`;
  button.classList.toggle('active', liveEnabled);
}

function renderTf(id, assessment) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = `radar-tf ${stateTone(assessment.state)}`;
  const b = el.querySelector('b');
  const small = el.querySelector('small');
  if (b) b.textContent = assessment.state === 'INSUFFICIENT' ? '—' : `${assessment.quality}/100`;
  if (small) small.textContent = assessment.state === 'INSUFFICIENT'
    ? assessment.reasons[0]
    : `${labelDirection(assessment.direction)} • ${assessment.reasons[0] || 'leitura estável'}`;
}

function renderRadar(state = {}, force = false) {
  if (!ensureUi()) return;
  const history = histories(state);
  const signature = JSON.stringify([
    marketId(state.asset),
    history.map(item => [item.asset,item.rows.length,item.rows.at(-1)?.time,item.rows.at(-1)?.close]),
    clean(state.analystPreferences?.operationMode || '')
  ]);
  if (!force && signature === lastRadarSignature && Date.now() - lastRenderedAt < 5000) return;
  lastRadarSignature = signature;
  lastRenderedAt = Date.now();

  const radar = scanMarket(state);
  const current = radar.current;
  document.getElementById('radarCoverage').textContent = `${radar.analyses.length} ativo${radar.analyses.length === 1 ? '' : 's'} com histórico`;

  const summary = document.getElementById('radarSummary');
  if (!current) {
    summary.innerHTML = '<strong>AGUARDANDO HISTÓRICO REAL</strong><p>Abra/observe ativos na CasaTrade para o radar comparar os cenários disponíveis.</p>';
    renderTf('radarM1', { state:'INSUFFICIENT', reasons:['sem M1 suficiente'] });
    renderTf('radarM5', { state:'INSUFFICIENT', reasons:['sem M5 suficiente'] });
  } else {
    renderTf('radarM1', current.m1);
    renderTf('radarM5', current.m5);
    const best = current.best;
    const mismatch = current.recommendation !== 'AGUARDAR' && current.currentTf && current.recommendation !== current.currentTf;
    const recommendation = current.recommendation === 'AGUARDAR' ? 'AGUARDAR' : `RADAR: MELHOR CENÁRIO ${current.recommendation}`;
    const reason = best ? [labelDirection(best.direction), ...(best.reasons || [])].join(' • ') : 'sem leitura suficiente';
    const modeNote = mismatch
      ? ` • Modo técnico ativo: ${current.currentTf}. O Radar não troca o modo automaticamente.`
      : '';
    summary.innerHTML = `<strong>${current.asset} • ${recommendation}</strong><p>${reason}${modeNote}</p>`;
  }

  const list = document.getElementById('radarOpportunities');
  const top = radar.analyses.filter(item => item.best && item.best.quality >= 55).slice(0, 4);
  list.innerHTML = top.length
    ? top.map(item => `<div class="radar-row"><span><b>${item.asset}</b><small>${labelDirection(item.best.direction)}</small></span><b>${item.recommendation}</b><small>${item.best.quality}/100</small></div>`).join('')
    : '<p class="radar-empty">Nenhuma oportunidade com histórico suficiente e qualidade mínima agora.</p>';
  syncLiveButton();
}

function normalizedExp(value) {
  const raw = clean(value).toLowerCase().replace(/\s+/g,'');
  if (/^(?:60s|1m|1min|1minuto)$/.test(raw)) return '60s';
  if (/^(?:300s|5m|5min|5minutos)$/.test(raw)) return '300s';
  if (/^(?:5s|5seg)$/.test(raw)) return '5s';
  if (/^(?:15s|15seg)$/.test(raw)) return '15s';
  if (/^(?:30s|30seg)$/.test(raw)) return '30s';
  return raw;
}

function renderEntrySafety(state = {}) {
  const root = ensureEntryCheckUi();
  if (!root) return;
  const professional = state.professionalDecision || {};
  const signal = state.signal || {};
  const professionalUi = clean(professional.uiState).toUpperCase();
  const technicalUi = clean(signal.uiState).toUpperCase();
  const hasProfessional = !!professionalUi || Number(professional.updatedAt || 0) > 0;
  const ui = hasProfessional ? professionalUi : technicalUi;
  const confirmed = hasProfessional
    ? professional.actionable === true && (ui === 'ENTER_BUY' || ui === 'ENTER_SELL')
    : signal.state === 'CONFIRM' || ui === 'ENTER_BUY' || ui === 'ENTER_SELL';

  if (!confirmed) {
    root.hidden = true;
    return;
  }

  const mode = clean(state.analystPreferences?.operationMode || state.analysisTimeframe || state.timeframe || 'M1').toUpperCase() === 'M5' ? 'M5' : 'M1';
  const requiredExp = mode === 'M5' ? '300s' : '60s';
  const requiredLabel = mode === 'M5' ? '5 min' : '1 min';
  const observedTf = clean(state.platformControls?.observed?.timeframe || state.analysisTimeframe || state.timeframe || '').toUpperCase();
  const observedExp = normalizedExp(state.platformControls?.observed?.expiration || '');
  const mismatch = (observedTf && observedTf !== mode) || (observedExp && observedExp !== requiredExp);
  const asset = marketId(state.asset) || 'ativo atual';
  const side = clean(professional.direction || signal.direction).toUpperCase() === 'SELL' ? 'VENDA' : 'COMPRA';

  root.hidden = false;
  root.classList.toggle('danger', mismatch);
  const text = document.getElementById('entrySafetyText');
  if (mismatch) {
    text.textContent = `NÃO ENTRE AINDA. Sinal: ${side} • ${asset} • ${mode} • ${requiredLabel}. A leitura visível da CasaTrade está diferente. Confira e ajuste manualmente antes de clicar na operação.`;
  } else {
    text.textContent = `Sinal: ${side} • ${asset} • ${mode} • ${requiredLabel}. Antes de clicar na CasaTrade, confira manualmente se ativo, timeframe e expiração estão exatamente assim.`;
  }
}

async function loadPrefs() {
  const stored = await chrome.storage.local.get(PREF_KEY).catch(() => ({}));
  liveEnabled = stored?.[PREF_KEY]?.liveEnabled !== false;
}

function renderAll(state = {}, force = false) {
  lastState = state || {};
  renderEntrySafety(lastState);
  if (liveEnabled || force) renderRadar(lastState, force);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STATE_KEY]) renderAll(changes[STATE_KEY].newValue || {});
  if (changes[ASSET_RADAR_KEY]) {
    assetRadarSnapshot = changes[ASSET_RADAR_KEY].newValue || { rows: [] };
    if (liveEnabled) renderRadar(lastState, true);
  }
  if (changes[PREF_KEY]) {
    liveEnabled = changes[PREF_KEY].newValue?.liveEnabled !== false;
    syncLiveButton();
  }
});

setInterval(() => {
  if (liveEnabled) renderRadar(lastState, false);
  renderEntrySafety(lastState);
}, 5000);

(async () => {
  await loadPrefs();
  const stored = await chrome.storage.local.get([STATE_KEY, ASSET_RADAR_KEY]).catch(() => ({}));
  lastState = stored?.[STATE_KEY] || {};
  assetRadarSnapshot = stored?.[ASSET_RADAR_KEY] || { rows: [] };
  ensureUi();
  ensureEntryCheckUi();
  renderAll(lastState, true);
})();
