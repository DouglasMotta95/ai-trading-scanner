const atsEntryNum = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const atsEntryText = value => atsEntryNum(value) == null ? '—' : String(value);

function renderRealEntry(state = {}) {
  const target = document.getElementById('targetTime');
  if (!target) return;

  const signal = state.signal || {};
  const licenseStatus = String(state.license?.status || '').toLowerCase();
  const licensed = licenseStatus === 'active' || licenseStatus === 'valid';
  const online = licensed && state.connection === 'online' && state.platformId === 'casatrade' && !!state.asset && atsEntryNum(state.price) != null;
  const realEntry = atsEntryNum(state.lastConfirmed?.entryPrice);

  target.textContent = !online
    ? '—'
    : signal.state === 'CONFIRM'
      ? 'AGUARDANDO ABERTURA REAL'
      : realEntry != null
        ? atsEntryText(realEntry)
        : '—';
}

async function syncRealEntry() {
  const { scannerState = {} } = await chrome.storage.local.get('scannerState').catch(() => ({}));
  renderRealEntry(scannerState);
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.scannerState) renderRealEntry(changes.scannerState.newValue || {});
});

const target = document.getElementById('targetTime');
if (target) {
  new MutationObserver(() => syncRealEntry().catch(() => {})).observe(target, { childList: true, characterData: true, subtree: true });
}

syncRealEntry().catch(() => {});
