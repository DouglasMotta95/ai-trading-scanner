const $ = id => document.getElementById(id);

function ensureBox() {
  let box = $('trialUsageBox');
  if (box) return box;
  const card = $('licenseCard');
  const text = $('licenseText');
  if (!card || !text) return null;
  box = document.createElement('div');
  box.id = 'trialUsageBox';
  box.className = 'trial-usage-box';
  box.innerHTML = '<span>TESTE DO PRODUTO</span><b id="trialUsageTitle">2 sinais disponíveis</b><small id="trialUsageText">O limite é controlado pelo servidor.</small>';
  text.insertAdjacentElement('afterend', box);
  return box;
}

function render(state = {}) {
  const license = state.license || {};
  const isTrial = license.isTrial === true || String(license.plan || '').toLowerCase() === 'trial';
  const box = ensureBox();
  if (!box) return;
  box.hidden = !isTrial;
  if (!isTrial) return;
  const remaining = license.remainingTotal ?? license.remainingToday ?? 0;
  const limit = license.totalLimit ?? license.dailyLimit ?? 2;
  if ($('trialUsageTitle')) $('trialUsageTitle').textContent = `${remaining} de ${limit} sinais restantes`;
  if ($('trialUsageText')) $('trialUsageText').textContent = remaining > 0
    ? 'Use os sinais de teste para ver a leitura ao vivo e a experiência do scanner.'
    : 'Teste concluído. Um plano ativo é necessário para liberar novos sinais.';
}

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: 'ATS_READ_SCANNER_STATE' }).catch(() => null);
  render(response?.state || {});
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) render(changes.scannerState.newValue || {});
});

refresh().catch(() => {});
