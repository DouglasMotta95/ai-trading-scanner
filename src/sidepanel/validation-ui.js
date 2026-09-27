(() => {
const $ = id => document.getElementById(id);

function pct(value) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(1).replace('.0','')}%`;
}

function render(metrics = {}) {
  const resolved = Math.max(0, Number(metrics.resolved || 0));
  const card = $('validationCard');
  if (card) card.hidden = resolved === 0;

  if ($('validationSample')) $('validationSample').textContent = metrics.sampleStatus || 'PEQUENA';
  if ($('validationEntries')) $('validationEntries').textContent = String(metrics.entries || 0);
  if ($('validationWins')) $('validationWins').textContent = String(metrics.entryWins || 0);
  if ($('validationLosses')) $('validationLosses').textContent = String(metrics.entryLosses || 0);
  if ($('validationWinRate')) $('validationWinRate').textContent = pct(metrics.entryWinRate);
  if ($('validationSkippedWins')) $('validationSkippedWins').textContent = String(metrics.skippedWouldWin || 0);
  if ($('validationAvoidedLosses')) $('validationAvoidedLosses').textContent = String(metrics.skippedWouldLose || 0);

  const bestAsset = Array.isArray(metrics.byAsset) ? metrics.byAsset.find(row => row.entries >= 3) : null;
  const bestSetup = Array.isArray(metrics.bySetup) ? metrics.bySetup.find(row => row.entries >= 3) : null;
  const topLoss = Array.isArray(metrics.lossesByReason) ? metrics.lossesByReason[0] : null;
  if ($('validationBestAsset')) $('validationBestAsset').textContent = bestAsset ? `${bestAsset.key} • ${pct(bestAsset.winRate)} (${bestAsset.entries})` : 'Aguardando amostra';
  if ($('validationBestSetup')) $('validationBestSetup').textContent = bestSetup ? `${bestSetup.key} • ${pct(bestSetup.winRate)} (${bestSetup.entries})` : 'Aguardando amostra';
  if ($('validationLossReason')) $('validationLossReason').textContent = topLoss ? `${topLoss.reason} • ${topLoss.count}` : 'Nenhum padrão ainda';

  if ($('validationBadge')) {
    $('validationBadge').textContent = `${resolved} RESOLVIDOS`;
    $('validationBadge').className = `badge ${resolved >= 50 ? 'ok' : 'warn'}`;
  }
  if ($('validationNote')) {
    $('validationNote').textContent = resolved < 50
      ? 'Amostra ainda pequena. Use estes números para calibração, não como promessa de taxa futura.'
      : 'Amostra útil para comparar ativos, setups e filtros. Continue acumulando dados antes de alterar regras centrais.';
  }
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_GET_SHADOW_CALIBRATION' }).catch(() => null);
  if (response?.ok) render(response.metrics || {});
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.atsShadowCalibrationV1?.newValue?.metrics) render(changes.atsShadowCalibrationV1.newValue.metrics);
});

import('./trial-ui.js').catch(() => {});
refresh().catch(() => {});
setInterval(() => refresh().catch(() => {}), 5000);

})();
