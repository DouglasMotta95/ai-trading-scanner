import { assessAssetQuality } from '../core/asset-quality.js';

const $ = id => document.getElementById(id);
const clean = value => String(value ?? '').trim().toUpperCase();
const num = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
function marketId(value = '') {
  const raw = clean(value);
  if (!raw) return '';
  const otc = /(?:\(|\b|[_-])OTC(?:\)|\b)?/.test(raw);
  const match = raw.match(/\b([A-Z0-9]{2,20})\s*[\/_-]\s*([A-Z0-9]{2,12})/);
  return match ? `${match[1]}/${match[2]}${otc ? ' (OTC)' : ''}` : '';
}
const sameMarket = (a, b) => !!marketId(a) && marketId(a) === marketId(b);

function liveCurrentMarket(state = {}) {
  const focus = state.diagnostics?.focusedAsset || {};
  const session = state.diagnostics?.marketSession || {};
  const seenAt = Number(state.lastSeen || 0);
  const rows = (Array.isArray(state.candles) ? state.candles : [])
    .filter(row => [row?.open,row?.high,row?.low,row?.close].every(value => num(value) != null));
  return !!state.asset
    && state.connection === 'online'
    && session.dataReady === true
    && sameMarket(session.confirmedAsset, state.asset)
    && sameMarket(focus.asset, state.asset)
    && focus.reliable === true
    && focus.chartScoped === true
    && num(state.price) != null
    && rows.length >= 2
    && seenAt > 0
    && Date.now() - seenAt < 10000;
}

function waitingQuality(state = {}) {
  const asset = String(state.asset || state.diagnostics?.focusedAsset?.asset || '').trim() || null;
  return {
    status: 'LOADING', tone: 'waiting', label: asset ? 'SINCRONIZANDO AVALIAÇÃO' : 'AGUARDANDO ATIVO AO VIVO',
    action: 'SINCRONIZANDO', score: null, context: asset ? 'CONFIRMANDO DADOS DO GRÁFICO' : 'SEM ATIVO CONFIRMADO',
    bias: '—', reason: asset
      ? `O ativo ${asset} foi visto, mas a avaliação só aparece depois que ativo, preço e sessão ao vivo estiverem confirmados juntos.`
      : 'Selecione um ativo na CasaTrade. A extensão não reutiliza avaliação antiga enquanto o ativo atual não estiver confirmado.'
  };
}

function renderQuality(state = {}) {
  const quality = liveCurrentMarket(state) ? assessAssetQuality(state) : waitingQuality(state);
  const card = $('assetQualityCard');
  if (!card) return;

  card.className = `card asset-quality-card ${quality.tone || 'waiting'}`;
  if ($('assetQualityTitle')) $('assetQualityTitle').textContent = quality.label || 'AVALIANDO ATIVO';
  if ($('assetQualityBadge')) {
    $('assetQualityBadge').textContent = quality.action || 'SINCRONIZANDO';
    $('assetQualityBadge').className = `badge ${quality.tone === 'good' ? 'ok' : quality.tone === 'bad' ? 'bad' : 'warn'}`;
  }
  if ($('assetQualityScore')) $('assetQualityScore').textContent = quality.score == null ? '—' : `${quality.score}/100`;
  if ($('assetQualityContext')) $('assetQualityContext').textContent = quality.context || '—';
  if ($('assetQualityBias')) $('assetQualityBias').textContent = quality.bias || '—';
  if ($('assetQualityReason')) $('assetQualityReason').textContent = quality.reason || 'Avaliando o gráfico atual.';
}

async function readState() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  renderQuality(response?.state || {});
}

chrome.storage.onChanged.addListener(changes => {
  if (!changes.scannerState) return;
  renderQuality(changes.scannerState.newValue || {});
});

readState().catch(() => renderQuality({}));
