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

test('manifest only injects supported CasaTrade capture scripts', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.service_worker, 'src/background-entry.js');
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html');
  assert.equal(manifest.optional_host_permissions, undefined);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /history-adapter|chart-overlay|background-platform-sync/);
  for (const host of manifest.content_scripts.flatMap(x => x.matches || [])) assert.match(host, /casatrade\.(com|io)/);
});

test('platform detection is strict and returns null for unrelated hosts', async () => {
  const { detectPlatform } = await import('../src/platforms/registry.js');
  assert.equal(detectPlatform('example.com'), null);
  assert.equal(detectPlatform('google.com'), null);
  assert.equal(detectPlatform('fake-casatrade.com'), null);
  assert.equal(detectPlatform('casatrade.com')?.id, 'casatrade');
  assert.equal(detectPlatform('app.casatrade.com')?.id, 'casatrade');
});

test('sidepanel contains only the six requested functional sections', () => {
  const html = read('src/sidepanel/index.html');
  for (const heading of ['1. LICENÇA','2. CONEXÃO CASATRADE','3. CONFIGURAÇÃO','4. ESTADO DO SINAL','5. PREPARAR ENTRADA','6. HISTÓRICO DA SESSÃO']) assert.match(html, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const removed of ['RSI','MACD','EMA 9','EMA 21','SUPORTE','RESISTÊNCIA','BACKTEST','RELATÓRIO SEMANAL','CORRELAÇÃO','CALENDÁRIO','NOTÍCIAS','MELHORES OPORTUNIDADES','RADAR MULTIATIVO','POR QUE A IA']) assert.doesNotMatch(html.toUpperCase(), new RegExp(removed));
  for (const id of ['licenseCard','connectionTitle','tradeAmount','analysisTimeframe','targetExpiration','signalTitle','signalReason','prepareBuy','prepareSell','signalHistory']) assert.match(html, new RegExp(`id=["']${id}["']`));
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

test('platform sync and trade preparation remain wired to real CasaTrade controls', () => {
  const background = read('src/background.js');
  const content = read('src/content/platform-sync.js');
  assert.match(background, /ATS_SYNC_PLATFORM_PREFERENCES/);
  assert.match(background, /ATS_READ_PLATFORM_CONTROLS/);
  assert.match(background, /platformControls/);
  assert.match(background, /aligned/);
  assert.match(content, /ATS_PLATFORM_READ/);
  assert.match(content, /ATS_PLATFORM_APPLY/);
  assert.match(content, /comprar\|vender\|buy\|sell/);
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
