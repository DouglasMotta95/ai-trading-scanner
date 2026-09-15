import { installationId } from './services/telemetry.js';
import { storageLocalGet, storageLocalSet } from './services/chrome-compat.js';

const INSTALL_KEY = 'atsInstallationId';
const LAST_VALID_LICENSE_KEY = 'atsLastValidLicense';
const validAnchor = value => /^ats-install-[0-9a-f-]{20,80}$/i.test(String(value || '').trim());
const casaHost = value => value === 'casatrade.com' || value.endsWith('.casatrade.com') || value === 'casatrade.io' || value.endsWith('.casatrade.io');

function trustedTopFrame(sender = {}) {
  if (!sender?.tab?.id || sender.frameId !== 0) return false;
  try { return casaHost(new URL(sender.url || sender.tab.url || '').hostname.toLowerCase()); }
  catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'ATS_DEVICE_ANCHOR' || !trustedTopFrame(sender)) return false;
  (async () => {
    const stored = await storageLocalGet([INSTALL_KEY, LAST_VALID_LICENSE_KEY]);
    const current = String(stored[INSTALL_KEY] || '').trim();
    const cachedLicense = stored[LAST_VALID_LICENSE_KEY] || null;
    const incoming = String(message.anchor || '').trim();

    // A CasaTrade-origin anchor survives replacing an unpacked build in the same
    // browser profile. On a fresh extension storage, restore that exact ID so the
    // license server sees the same physical browser instead of a new device.
    if (validAnchor(incoming) && (!current || !cachedLicense)) {
      await storageLocalSet({ [INSTALL_KEY]: incoming });
      return { ok: true, anchor: incoming, restored: current !== incoming };
    }

    if (validAnchor(current)) return { ok: true, anchor: current, restored: false };
    const generated = await installationId();
    return { ok: true, anchor: generated, restored: false };
  })().then(sendResponse).catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
