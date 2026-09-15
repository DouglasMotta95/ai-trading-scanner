import { assessAssetQuality } from '../core/asset-quality.js';

const $ = id => document.getElementById(id);

function renderQuality(state = {}) {
  const quality = assessAssetQuality(state);
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
