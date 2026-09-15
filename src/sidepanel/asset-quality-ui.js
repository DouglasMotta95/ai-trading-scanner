import { assessAssetQuality } from '../core/asset-quality.js';

const $ = id => document.getElementById(id);
const clean = value => String(value ?? '').trim().toUpperCase();

function liveCurrentMarket(state = {}) {
  const focus = state.diagnostics?.focusedAsset || null;
  const asset = clean(state.asset);
  const focused = clean(focus?.asset);
  const seenAt = Number(state.lastSeen || 0);
  return !!asset
    && state.connection === 'online'
    && seenAt > 0
    && Date.now() - seenAt < 10000
    && (!focused || focused === asset);
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
