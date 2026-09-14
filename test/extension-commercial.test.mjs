import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const REMOVED = [
  'src/core/ai-scoring.js',
  'src/core/backtest.js',
  'src/core/correlation.js',
  'src/core/market-structure.js',
  'src/core/reporting.js',
  'src/content/chart-overlay.js',
  'src/content/history-adapter.js',
  'src/background-platform-sync.js'
];

const standalone = term => new RegExp(`(?:^|[^A-ZÀ-ÖØ-Þ])${term}(?:$|[^A-ZÀ-ÖØ-Þ])`);

test('manifest only injects supported CasaTrade capture scripts and trusted embedded trader frames', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.service_worker, 'src/background-entry.js');
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html');
  assert.equal(manifest.optional_host_permissions, undefined);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /history-adapter|chart-overlay|background-platform-sync/);
  for (const host of manifest.content_scripts.flatMap(x => x.matches || [])) {
    assert.match(host, /casatrade\.(com|io)|(?:iv)?casatraders\.online/);
  }
});

test('platform detection is strict and returns null for unrelated or embedded-frame-only hosts', async () => {
  const { detectPlatform } = await import('../src/platforms/registry.js');
  assert.equal(detectPlatform('example.com'), null);
  assert.equal(detectPlatform('google.com'), null);
  assert.equal(detectPlatform('fake-casatrade.com'), null);
  assert.equal(detectPlatform('casatraders.online'), null);
  assert.equal(detectPlatform('ivcasatraders.online'), null);
  assert.equal(detectPlatform('casatrade.com')?.id, 'casatrade');
  assert.equal(detectPlatform('app.casatrade.com')?.id, 'casatrade');
});

test('sidepanel is focused on license, live candle analysis and next entry', () => {
  const html = read('src/sidepanel/index.html');
  for (const heading of ['1. LICENÇA','2. VELA EM ANÁLISE','3. PRÓXIMA VELA']) assert.match(html, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const removed of ['RSI','MACD','EMA 9','EMA 21','SUPORTE','RESISTÊNCIA','BACKTEST','RELATÓRIO SEMANAL','CORRELAÇÃO','CALENDÁRIO','NOTÍCIAS','MELHORES OPORTUNIDADES','RADAR MULTIATIVO','POR QUE A IA']) assert.doesNotMatch(html.toUpperCase(), standalone(removed));
  for (const id of ['licenseCard','analysisTitle','asset','price','secondsRemaining','timeframe','expiration','recentCandles','prepareBuy','prepareSell','signalTitle','signalReason','decisionText','targetTime']) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.doesNotMatch(html, /tradeAmount|analysisTimeframe|targetExpiration|syncPlatformBtn|signalHistory/);
});

test('removed unauthorized files are physically absent', () => {
  for (const file of REMOVED) assert.equal(fs.existsSync(path.join(root, file)), false, `${file} must be deleted`);
});

test('no extension source references removed modules', () => {
  const sourceFiles = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (/\.(js|html|json)$/.test(name)) sourceFiles.push(full);
    }
  };
  walk(path.join(root, 'src'));
  sourceFiles.push(path.join(root, 'manifest.json'));
  const body = sourceFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
  for (const name of ['ai-scoring.js','backtest.js','correlation.js','market-structure.js','reporting.js','chart-overlay.js','history-adapter.js','background-platform-sync.js']) assert.doesNotMatch(body, new RegExp(name.replace('.', '\\.')));
});

test('background clears unsupported active-tab market state and blocks foreign snapshots', () => {
  const background = read('src/background.js');
  assert.match(background, /marketCleared/);
  assert.match(background, /platform_not_registered/);
  assert.match(background, /if \(!platform \|\| !sameTarget/);
  assert.match(background, /asset: null/);
  assert.match(background, /price: null/);
  assert.match(background, /signal: null/);
});

test('platform readers remain wired to real CasaTrade controls', () => {
  const background = read('src/background.js');
  const content = read('src/content/platform-sync.js');
  assert.match(background, /ATS_READ_PLATFORM_CONTROLS/);
  assert.match(background, /platformControls/);
  assert.match(content, /ATS_PLATFORM_READ/);
  assert.match(content, /comprar\|vender\|buy\|sell/);
});

test('market feed is filtered to the authoritative visible chart asset before it can drive a decision', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const focus = read('src/content/focused-asset-v2.js');
  const augment = read('src/background-augment.js');
  const generic = read('src/content/generic-adapter.js');
  const evidence = read('src/core/market-evidence.js');

  assert.ok(manifest.content_scripts.some(x => (x.js || []).includes('src/content/focused-asset-v2.js')));
  assert.match(focus, /ATS_VISUAL_FOCUS_V2/);
  assert.match(focus, /chartScoped: true/);
  assert.match(focus, /frameRole: 'trader-frame'/);

  assert.match(augment, /focusedAssets/);
  assert.match(augment, /function chooseCandidate\(payload = \{\}, preferredAsset = ''\)/);
  assert.match(augment, /filter\(row => sameAsset\(row\.asset, focus\)\)/);
  assert.match(augment, /const frameMatchesFocus =/);
  assert.match(augment, /if \(!frameMatchesFocus\) return/);
  assert.match(augment, /function authoritativeClock\(/);
  assert.match(augment, /if \(!clock\) return base/);

  assert.match(generic, /bestDomAsset/);
  assert.match(generic, /bestNetworkQuote\(''\)/);
  assert.match(generic, /dom-fallback/);
  assert.match(generic, /network-fallback/);

  assert.match(evidence, /resolveMarketEvidence/);
  assert.match(evidence, /focusCorroborated/);
  assert.match(evidence, /confidence \|\| 0\) >= 82/);
  assert.match(evidence, /seenCount \|\| 0\) >= 2/);
});

test('trade handoff highlights but never executes financial action automatically', () => {
  const handoff = read('src/content/trade-handoff.js');
  assert.match(handoff, /ATS_HIGHLIGHT_TRADE/);
  assert.doesNotMatch(handoff, /\.click\s*\(/);
  assert.doesNotMatch(handoff, /dispatchEvent\s*\(\s*new\s+MouseEvent/);
});

test('license persistence remains cache-first', () => {
  const license = read('src/services/license.js');
  const panel = read('src/sidepanel/app.js');
  assert.match(license, /atsLastValidLicense/);
  assert.match(license, /REOPEN_CACHE_GRACE_MS/);
  assert.match(license, /AUTHORITATIVE_LICENSE_ERRORS/);
  assert.match(panel, /atsLastValidLicense/);
  assert.match(panel, /effectiveLicense/);
});
