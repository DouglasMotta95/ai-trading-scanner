import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const PUBLIC_API = 'https://ats-control-center-v07-production.up.railway.app';

test('manifest has a single side-panel entry point', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.service_worker, 'src/background-entry.js');
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.action?.default_title, 'AI Trading Scanner');
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html');
  assert.equal(manifest.options_page, 'src/admin/index.html');
  assert.ok(manifest.host_permissions.includes('https://*.casatrade.com/*'));
  assert.ok(manifest.host_permissions.includes('https://*.casatrade.io/*'));
  assert.ok(manifest.permissions.includes('sidePanel'));
  assert.ok(manifest.permissions.includes('scripting'));
  const background = read('src/background.js');
  assert.match(background, /setPanelBehavior\(\{openPanelOnActionClick:true\}\)/);
});

test('sidepanel primary controls exist and are wired', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  const background = read('src/background.js');
  for (const id of ['settingsBtn','connectBtn','toggleScanner','analysisTimeframe','targetExpiration','prepareBuy','prepareSell','activateLicense']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const msg of ['ATS_CONNECT_ACTIVE_TAB','ATS_SET_SCANNER','ATS_PREPARE_TRADE','ATS_ACTIVATE_LICENSE','ATS_GET_STATE']) {
    assert.ok(app.includes(msg), `sidepanel does not send ${msg}`);
    assert.ok(background.includes(msg), `background does not handle ${msg}`);
  }
  assert.match(app, /buyBtn\.addEventListener\(['"]click['"]/);
  assert.match(app, /sellBtn\.addEventListener\(['"]click['"]/);
  assert.match(app, /toggleBtn\.addEventListener\(['"]click['"]/);
  assert.match(app, /connectBtn\.addEventListener\(['"]click['"]/);
  assert.ok(app.includes("$('settingsBtn').addEventListener('click'"));
});

test('account login and preflight are explicitly loaded by the side panel', () => {
  const html = read('src/sidepanel/index.html');
  const account = read('src/sidepanel/account-login.js');
  const preflight = read('src/sidepanel/preflight.js');
  assert.match(html, /<script src="account-login\.js"><\/script>/);
  assert.match(html, /<script src="preflight\.js"><\/script>/);
  assert.ok(account.includes('/v1/customer/extension/exchange'));
  assert.ok(account.includes('/v1/customer/extension/refresh'));
  assert.ok(account.includes('manualKeyToggle'));
  assert.match(preflight, /VALOR PLANEJADO/);
  assert.match(preflight, /TODOS OS ATIVOS DETECTADOS/);
  assert.match(preflight, /ATS_SET_SCANNER/);
});

test('license API requests have an eight-second abort timeout', () => {
  const license = read('src/services/license.js');
  assert.match(license, /REQUEST_TIMEOUT_MS\s*=\s*8000/);
  assert.match(license, /new AbortController\(\)/);
  assert.match(license, /controller\.abort\(\)/);
  assert.match(license, /signal:\s*controller\.signal/);
  assert.match(license, /backend_unreachable/);
});

test('sidepanel version is read from the manifest', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  assert.match(html, /id="extensionVersion"/);
  assert.doesNotMatch(html, /v0\.8\.0/);
  assert.match(app, /chrome\.runtime\.getManifest\(\)\.version/);
});

test('commercial licensing cannot be bypassed by an unpacked build or custom backend', () => {
  const license = read('src/services/license.js');
  const telemetry = read('src/services/telemetry.js');
  const account = read('src/sidepanel/account-login.js');
  const admin = read('src/admin/admin.js');
  assert.match(license, /licenseRequired\s*=\s*\(\)\s*=>\s*true/);
  assert.ok(license.includes(PUBLIC_API));
  assert.ok(telemetry.includes(PUBLIC_API));
  assert.ok(account.includes(PUBLIC_API));
  assert.ok(admin.includes(PUBLIC_API));
  assert.doesNotMatch(license, /settings\?\.apiBase|settings\.apiBase/);
  assert.doesNotMatch(telemetry, /settings\?\.apiBase|settings\.apiBase/);
});

test('trade handoff highlights controls but never performs the financial click', () => {
  const handoff = read('src/content/trade-handoff.js');
  assert.ok(handoff.includes('ATS_HIGHLIGHT_TRADE'));
  assert.ok(handoff.includes('scrollIntoView'));
  assert.doesNotMatch(handoff, /\.click\s*\(/);
  assert.doesNotMatch(handoff, /dispatchEvent\s*\(\s*new\s+MouseEvent/);
});

test('network probe intentionally excludes authentication/session fields', () => {
  const probe = read('src/content/network-probe.js');
  assert.match(probe, /token\|auth\|cookie\|session\|password\|secret\|bearer/);
  assert.ok(probe.includes('request bodies'));
  assert.ok(probe.includes('auth/session fields'));
});

test('network candidates can promote a matching quote into the structured feed', () => {
  const adapter = read('src/content/generic-adapter.js');
  assert.ok(adapter.includes('structuredNetworkQuote'));
  assert.ok(adapter.includes('structuredQuotes: structured'));
  assert.ok(adapter.includes('seenCount || 0) >= 2'));
});
