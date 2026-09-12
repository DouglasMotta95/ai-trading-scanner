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

test('manifest injects capture scripts only into the real CasaTrade web app', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background?.service_worker, 'src/background-entry.js');
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html');
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts.flatMap(x => x.matches || []), [
    'https://trade.casatrade.com/*',
    'https://trade.casatrade.com/*'
  ]);
  assert.ok(manifest.host_permissions.includes('https://trade.casatrade.com/*'));
  assert.ok(manifest.host_permissions.includes('https://ats-control-center-v07-production.up.railway.app/*'));
  assert.equal(manifest.host_permissions.some(x => /(?:^|\.)casatrade\.io\//.test(x)), false);
  assert.equal(manifest.host_permissions.some(x => /https:\/\/(?:www\.|app\.)?casatrade\.com\//.test(x)), false);
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /history-adapter|chart-overlay|background-platform-sync/);
});

test('platform detection is strict and rejects CasaTrade marketing or guessed hosts', async () => {
  const { detectPlatform } = await import('../src/platforms/registry.js');
  assert.equal(detectPlatform('trade.casatrade.com')?.id, 'casatrade');
  for (const host of ['casatrade.com', 'www.casatrade.com', 'app.casatrade.com', 'trade.casatrade.io', 'example.com', 'google.com', 'fake-casatrade.com']) {
    assert.equal(detectPlatform(host), null);
  }
});

test('sidepanel contains only the six requested functional sections', () => {
  const html = read('src/sidepanel/index.html');
  const headings = ['1. LICENÇA','2. CONEXÃO CASATRADE','3. CONFIGURAÇÃO','4. ESTADO DO SINAL','5. PREPARAR ENTRADA','6. HISTÓRICO DA SESSÃO'];
  for (const heading of headings) assert.ok(html.includes(heading), `missing ${heading}`);
  assert.equal((html.match(/<section\b/g) || []).length, 6);
  assert.equal(html.includes('account-login.js'), false);
  for (const removed of ['RSI','MACD','EMA 9','EMA 21','SUPORTE','RESISTÊNCIA','BACKTEST','RELATÓRIO SEMANAL','CORRELAÇÃO','CALENDÁRIO','NOTÍCIAS','MELHORES OPORTUNIDADES','RADAR MULTIATIVO','POR QUE A IA']) {
    assert.equal(html.toUpperCase().includes(removed), false, `${removed} must not be rendered`);
  }
  for (const id of ['licenseCard','connectionTitle','tradeAmount','analysisTimeframe','targetExpiration','signalTitle','signalReason','prepareBuy','prepareSell','signalHistory']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
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
  for (const name of ['ai-scoring.js','backtest.js','correlation.js','market-structure.js','reporting.js','chart-overlay.js','history-adapter.js','background-platform-sync.js']) {
    assert.equal(body.includes(name), false, `${name} must not be referenced`);
  }
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

test('platform sync is host locked and fails closed when controls are ambiguous', () => {
  const background = read('src/background.js');
  const content = read('src/content/platform-sync.js');
  assert.match(background, /ATS_SYNC_PLATFORM_PREFERENCES/);
  assert.match(background, /ATS_READ_PLATFORM_CONTROLS/);
  assert.match(background, /platformControls/);
  assert.match(background, /aligned/);
  assert.ok(content.includes("location.hostname || '').toLowerCase() !== 'trade.casatrade.com'"));
  assert.match(content, /ATS_PLATFORM_READ/);
  assert.match(content, /ATS_PLATFORM_APPLY/);
  assert.match(content, /ranked\[0\]\.score - ranked\[1\]\.score < 3/);
  assert.match(content, /comprar\|vender\|buy\|sell/);
});

test('trade handoff highlights but never executes financial action automatically', () => {
  const handoff = read('src/content/trade-handoff.js');
  assert.match(handoff, /ATS_HIGHLIGHT_TRADE/);
  assert.doesNotMatch(handoff, /\.click\s*\(/);
  assert.doesNotMatch(handoff, /dispatchEvent\s*\(\s*new\s+MouseEvent/);
});

test('license reopen restores cache before requesting state and does not auto-revalidate', () => {
  const license = read('src/services/license.js');
  const panel = read('src/sidepanel/app.js');
  assert.match(license, /atsLastValidLicense/);
  assert.match(license, /REOPEN_CACHE_GRACE_MS/);
  assert.match(license, /AUTHORITATIVE_LICENSE_ERRORS/);
  assert.match(panel, /restoreLicenseBeforeState/);
  assert.match(panel, /await restoreLicenseBeforeState\(\);[\s\S]*await getState\(\);/);
  const boot = panel.slice(panel.lastIndexOf('(async () =>'));
  assert.equal(boot.includes('ATS_VALIDATE_LICENSE'), false);
});