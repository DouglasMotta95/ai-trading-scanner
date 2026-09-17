const LICENSE_KEY = 'atsLicenseKey';
const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
let lastNonEmptyKey = '';
let restoring = false;

async function seed() {
  const stored = await chrome.storage.local.get([LICENSE_KEY, LAST_VALID_LICENSE_KEY]);
  lastNonEmptyKey = String(stored[LICENSE_KEY] || stored[LAST_VALID_LICENSE_KEY]?.licenseKey || stored[LAST_VALID_LICENSE_KEY]?.license?.key || '').trim();
  if (lastNonEmptyKey && !stored[LICENSE_KEY]) await chrome.storage.local.set({ [LICENSE_KEY]: lastNonEmptyKey });
}
seed().catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || restoring) return;
  const keyChange = changes[LICENSE_KEY];
  const cacheChange = changes[LAST_VALID_LICENSE_KEY];
  const nextKey = String(keyChange?.newValue || '').trim();
  if (nextKey) lastNonEmptyKey = nextKey;
  const cachedKey = String(cacheChange?.newValue?.licenseKey || cacheChange?.newValue?.license?.key || '').trim();
  if (cachedKey) lastNonEmptyKey = cachedKey;
  if (!lastNonEmptyKey) return;
  const keyWasErased = !!keyChange && !nextKey;
  const cacheLostKey = !!cacheChange?.newValue?.license && !cachedKey;
  if (!keyWasErased && !cacheLostKey) return;
  restoring = true;
  (async () => {
    const current = await chrome.storage.local.get(LAST_VALID_LICENSE_KEY);
    const values = { [LICENSE_KEY]: lastNonEmptyKey };
    if (current[LAST_VALID_LICENSE_KEY]?.license) values[LAST_VALID_LICENSE_KEY] = { ...current[LAST_VALID_LICENSE_KEY], licenseKey: lastNonEmptyKey };
    await chrome.storage.local.set(values);
  })().catch(() => {}).finally(() => { restoring = false; });
});
