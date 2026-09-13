const atsEntryNum = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const atsEntryText = value => atsEntryNum(value) == null ? '—' : String(value);
const ATS_ENTRY_FRESH_MS = 8000;
let atsEntryObserver = null;

const atsEntryFresh = state => {
  const lastSeen = Number(state?.lastSeen);
  if (!Number.isFinite(lastSeen) || lastSeen <= 0) return false;
  const age = Date.now() - lastSeen;
  return age >= 0 && age <= ATS_ENTRY_FRESH_MS;
};

const observeEntryTarget = target => {
  if (!target || !atsEntryObserver) return;
  atsEntryObserver.observe(target, { childList: true, characterData: true, subtree: true });
};

const setEntryText = (target, text) => {
  if (!target || target.textContent === text) return;
  atsEntryObserver?.disconnect();
  target.textContent = text;
  observeEntryTarget(target);
};

function renderRealEntry(state = {}) {
  const target = document.getElementById('targetTime');
  if (!target) return;

  const signal = state.signal || {};
  const licenseStatus = String(state.license?.status || '').toLowerCase();
  const licensed = licenseStatus === 'active' || licenseStatus === 'valid';
  const online = licensed
    && state.connection === 'online'
    && state.platformId === 'casatrade'
    && !!state.asset
    && atsEntryNum(state.price) != null
    && atsEntryFresh(state);
  const realEntry = atsEntryNum(state.lastConfirmed?.entryPrice);
  const entryUnconfirmed = state.lastConfirmed?.state === 'CONFIRM' && state.lastConfirmed?.entryConfirmed === false;

  const text = !online
    ? '—'
    : signal.state === 'CONFIRM'
      ? 'AGUARDANDO ABERTURA REAL'
      : entryUnconfirmed
        ? 'PREÇO DE ENTRADA NÃO CONFIRMADO'
        : realEntry != null
          ? atsEntryText(realEntry)
          : '—';

  setEntryText(target, text);
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
  atsEntryObserver = new MutationObserver(() => syncRealEntry().catch(() => {}));
  observeEntryTarget(target);
}

syncRealEntry().catch(() => {});