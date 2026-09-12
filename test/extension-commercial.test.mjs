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
  const isolated = manifest.content_scripts.find(x => x.world !== 'MAIN');
  assert.ok(isolated.js.includes('src/content/platform-sync.js'));
  assert.ok(isolated.js.includes('src/content/history-adapter.js'));
  const background = read('src/background.js');
  assert.match(background, /setPanelBehavior\(\{openPanelOnActionClick:true\}\)/);
});

test('sidepanel primary controls exist and are wired', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  const experience = read('src/sidepanel/experience.js');
  const background = read('src/background.js');
  for (const id of ['settingsBtn','connectBtn','toggleScanner','tradeAmount','analysisTimeframe','targetExpiration','prepareBuy','prepareSell','activateLicense']) {
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
  assert.match(experience, /SINCRONIZE PARA INICIAR/);
  assert.match(experience, /state\.signal\?\.state!==['"]CONFIRM['"]/);
});

test('account login and synchronized trading experience are explicitly loaded by the side panel', () => {
  const html = read('src/sidepanel/index.html');
  const account = read('src/sidepanel/account-login.js');
  const experience = read('src/sidepanel/experience.js');
  assert.match(html, /<script src="account-login\.js"><\/script>/);
  assert.match(html, /<script src="experience\.js"><\/script>/);
  assert.doesNotMatch(html, /preflight\.js/);
  assert.equal(fs.existsSync(path.join(root, 'src/sidepanel/preflight.js')), false);
  assert.ok(account.includes('/v1/customer/extension/exchange'));
  assert.ok(account.includes('/v1/customer/extension/refresh'));
  assert.ok(account.includes('manualKeyToggle'));
  assert.match(html, /VALOR DA ENTRADA/);
  assert.match(html, /M2 • 2 MIN/);
  assert.match(html, /ENTRADA NA PLATAFORMA/);
  assert.match(experience, /ATS_SYNC_PLATFORM_PREFERENCES/);
  assert.match(experience, /CasaTrade sincronizada/);
  assert.match(experience, /não vou inventar entrada/);
});

test('CasaTrade settings synchronizer reads back and safely applies non-financial controls', () => {
  const content = read('src/content/platform-sync.js');
  const background = read('src/background-platform-sync.js');
  assert.match(content, /ATS_PLATFORM_READ/);
  assert.match(content, /ATS_PLATFORM_APPLY/);
  assert.match(content, /excludeFinancialAction/);
  assert.match(content, /comprar\|vender\|buy\|sell/);
  assert.match(content, /result\.matched/);
  assert.match(content, /detectAsset/);
  assert.match(background, /ATS_READ_PLATFORM_CONTROLS/);
  assert.match(background, /ATS_SYNC_PLATFORM_PREFERENCES/);
  assert.match(background, /platformControls/);
  assert.match(background, /aligned/);
  assert.match(background, /patch\.scanner = 'idle'/);
  assert.match(background, /patch\.asset = observed\.asset/);
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

test('valid license is cached locally and survives temporary backend unavailability', () => {
  const license = read('src/services/license.js');
  const panel = read('src/sidepanel/app.js');
  const account = read('src/sidepanel/account-login.js');
  assert.match(license, /atsLastValidLicense/);
  assert.match(license, /cachedLicenseSession/);
  assert.match(license, /offlineFallback:\s*true/);
  assert.match(license, /AUTHORITATIVE_LICENSE_ERRORS/);
  assert.match(license, /syncPending:\s*true/);
  assert.match(license, /chrome\.storage\.local\.remove\(LAST_VALID_LICENSE_KEY\)/);
  assert.match(panel, /atsLastValidLicense/);
  assert.match(panel, /effectiveLicense/);
  assert.match(panel, /Licença ativa • aguardando sincronização/);
  assert.match(panel, /await getState\(\);\s*chrome\.runtime\.sendMessage\(\{type:'ATS_VALIDATE_LICENSE'\}\)/s);
  assert.match(account, /atsLastValidLicense/);
  assert.match(account, /validatedAt:\s*Date\.now\(\)/);
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

test('real recent candle history can seed analysis without inventing candles', () => {
  const probe = read('src/content/network-probe.js');
  const augment = read('src/background-augment.js');
  const history = read('src/content/history-adapter.js');
  const candles = read('src/core/candles.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(probe, /recentCandles/);
  assert.match(probe, /recordCandle/);
  assert.match(augment, /sanitizeRecentCandles/);
  assert.match(augment, /marketHistory/);
  assert.match(history, /seenCount \|\| 0\) >= 2/);
  assert.match(history, /Date\.now\(\) - Number\(c\?\.observedAt \|\| 0\) <= 6000/);
  assert.match(history, /structuredQuotes: structured/);
  assert.match(candles, /seed\(candles=\[\]\)/);
  assert.match(candles, /M2:120000/);
  assert.match(orchestrator, /builder\.seed\(snapshot\.candles\)/);
  assert.match(orchestrator, /recentFlow/);
});

test('network candidates can promote a matching quote into the structured feed', () => {
  const adapter = read('src/content/generic-adapter.js');
  assert.ok(adapter.includes('structuredNetworkQuote'));
  assert.ok(adapter.includes('structuredQuotes: structured'));
  assert.ok(adapter.includes('seenCount || 0) >= 2'));
});
