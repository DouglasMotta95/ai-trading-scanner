import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const PUBLIC_API = 'https://ats-control-center-v07-production.up.railway.app';

test('manifest has one sidepanel and all CasaTrade capture scripts', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.9.6');
  assert.equal(manifest.background?.service_worker, 'src/background-entry.js');
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html');
  assert.ok(manifest.host_permissions.includes('https://*.casatrade.com/*'));
  const isolated = manifest.content_scripts.find(x => x.world !== 'MAIN');
  for (const file of ['src/content/network-bridge.js','src/content/generic-adapter.js','src/content/platform-sync.js','src/content/history-adapter.js']) assert.ok(isolated.js.includes(file));
});

test('sidepanel is Portuguese, commercial and natively synchronized', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  for (const id of ['settingsBtn','connectBtn','toggleScanner','tradeAmount','analysisTimeframe','targetExpiration','prepareBuy','prepareSell','activateLicense','intelligenceList']) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /CONFIGURE SUA OPERAÇÃO/);
  assert.match(html, /MERCADO EM FOCO/);
  assert.match(html, /INTELIGÊNCIA DE MERCADO/);
  assert.match(html, /Quando houver sinal, ele aparece aqui/);
  assert.doesNotMatch(html, /experience\.js|preflight\.js/);
  assert.equal(fs.existsSync(path.join(root, 'src/sidepanel/experience.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/sidepanel/preflight.js')), false);
  for (const msg of ['ATS_CONNECT_ACTIVE_TAB','ATS_SET_SCANNER','ATS_PREPARE_TRADE','ATS_ACTIVATE_LICENSE','ATS_GET_STATE','ATS_SYNC_PLATFORM_PREFERENCES']) assert.ok(app.includes(msg));
  assert.match(app, /maybeAutoConnect/);
  assert.match(app, /CasaTrade sincronizada/);
  assert.match(app, /Não vou|não vou/i);
  assert.match(app, /signal\?\.state|sig\.state/);
});

test('CasaTrade registry has concrete selectors and multi-timeframe patterns', () => {
  const registry = read('src/platforms/registry.js');
  assert.match(registry, /data-testid\*="asset"/i);
  assert.match(registry, /data-testid\*="price"/i);
  assert.match(registry, /expiration/);
  assert.match(registry, /amount/);
  assert.match(registry, /M\(\?:1\|2\|5/);
  assert.match(registry, /canonicalAsset/);
});

test('network probe decodes websocket frames and keeps sensitive data out', () => {
  const probe = read('src/content/network-probe.js');
  assert.match(probe, /Socket|decodeStringFrames|42\|45|event-stream/);
  assert.match(probe, /SENSITIVE/);
  assert.match(probe, /token\|auth\|cookie\|session\|password\|secret\|bearer/);
  assert.match(probe, /feedQuality/);
  assert.match(probe, /recentCandles/);
  assert.match(probe, /confidence/);
  assert.match(probe, /primaryTransport/);
  assert.doesNotMatch(probe, /request\.headers|document\.cookie|localStorage\.getItem\(['"]token/i);
});

test('generic adapter matches active asset, DOM catalog and structured network quote', () => {
  const adapter = read('src/content/generic-adapter.js');
  assert.match(adapter, /scanDomAssets/);
  assert.match(adapter, /selectedAsset/);
  assert.match(adapter, /structuredNetworkQuote/);
  assert.match(adapter, /canonicalAsset/);
  assert.match(adapter, /catalogAssets/);
  assert.match(adapter, /svg text/);
  assert.match(adapter, /structuredQuotes: structured/);
  assert.match(adapter, /candles: history/);
});

test('automatic multi-asset intelligence ranks markets without pretending external AI', () => {
  const augment = read('src/background-augment.js');
  assert.match(augment, /intelligenceFrom/);
  assert.match(augment, /sessionContext/);
  assert.match(augment, /ranking-quantitativo-local/);
  assert.match(augment, /externalAi: 'nao_configurada'/);
  assert.match(augment, /marketIntelligence/);
  assert.match(augment, /universeAnalysis/);
  assert.match(augment, /recentCandles/);
});

test('CasaTrade settings synchronizer reads back and safely applies non-financial controls', () => {
  const content = read('src/content/platform-sync.js');
  const background = read('src/background-platform-sync.js');
  assert.match(content, /ATS_PLATFORM_READ/);
  assert.match(content, /ATS_PLATFORM_APPLY/);
  assert.match(content, /excludeFinancialAction/);
  assert.match(content, /comprar\|vender\|buy\|sell/);
  assert.match(background, /ATS_READ_PLATFORM_CONTROLS/);
  assert.match(background, /ATS_SYNC_PLATFORM_PREFERENCES/);
  assert.match(background, /platformControls/);
  assert.match(background, /aligned/);
  assert.match(background, /patch\.scanner = 'idle'/);
});

test('license API requests have an eight-second abort timeout', () => {
  const license = read('src/services/license.js');
  assert.match(license, /REQUEST_TIMEOUT_MS\s*=\s*8000/);
  assert.match(license, /new AbortController\(\)/);
  assert.match(license, /controller\.abort\(\)/);
  assert.match(license, /backend_unreachable/);
});

test('valid license cache survives temporary backend unavailability', () => {
  const license = read('src/services/license.js');
  const panel = read('src/sidepanel/app.js');
  const account = read('src/sidepanel/account-login.js');
  assert.match(license, /atsLastValidLicense/);
  assert.match(license, /cachedLicenseSession/);
  assert.match(license, /AUTHORITATIVE_LICENSE_ERRORS/);
  assert.match(panel, /atsLastValidLicense/);
  assert.match(panel, /effectiveLicense/);
  assert.match(panel, /Licença ativa • sincronizando/);
  assert.match(account, /atsLastValidLicense/);
});

test('trade handoff highlights but does not click financial order', () => {
  const handoff = read('src/content/trade-handoff.js');
  assert.ok(handoff.includes('ATS_HIGHLIGHT_TRADE'));
  assert.ok(handoff.includes('scrollIntoView'));
  assert.doesNotMatch(handoff, /\.click\s*\(/);
  assert.doesNotMatch(handoff, /dispatchEvent\s*\(\s*new\s+MouseEvent/);
});

test('real recent candles seed analysis and M2 is supported', () => {
  const candles = read('src/core/candles.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(candles, /seed\(candles=\[\]\)/);
  assert.match(candles, /M2:120000/);
  assert.match(orchestrator, /builder\.seed\(snapshot\.candles\)/);
  assert.match(orchestrator, /recentFlow/);
});

test('commercial licensing remains pinned to production API', () => {
  const license = read('src/services/license.js');
  const telemetry = read('src/services/telemetry.js');
  const account = read('src/sidepanel/account-login.js');
  assert.match(license, /licenseRequired\s*=\s*\(\)\s*=>\s*true/);
  assert.ok(license.includes(PUBLIC_API));
  assert.ok(telemetry.includes(PUBLIC_API));
  assert.ok(account.includes(PUBLIC_API));
});
