import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const PUBLIC_API = 'https://ats-control-center-v07-production.up.railway.app';

test('manifest has one sidepanel and all CasaTrade capture/overlay scripts', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.10.0');
  assert.equal(manifest.background?.service_worker, 'src/background-entry.js');
  assert.equal(manifest.action?.default_popup, undefined);
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html');
  assert.ok(manifest.host_permissions.includes('https://*.casatrade.com/*'));
  const isolated = manifest.content_scripts.find(x => x.world !== 'MAIN');
  for (const file of ['src/content/network-bridge.js','src/content/generic-adapter.js','src/content/platform-sync.js','src/content/history-adapter.js','src/content/chart-overlay.js']) assert.ok(isolated.js.includes(file));
});

test('sidepanel is Portuguese, professional, synchronized and risk-aware', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  for (const id of ['settingsBtn','connectBtn','toggleScanner','tradeAmount','analysisTimeframe','targetExpiration','prepareBuy','prepareSell','activateLicense','intelligenceList','pauseAllBtn','riskProfile','bankroll','dailyTarget','runBacktestBtn','weeklyReportBtn','chartLinesToggle','onlyAToggle','scalpingToggle']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /CONFIGURE SUA OPERAÇÃO/);
  assert.match(html, /MERCADO EM FOCO/);
  assert.match(html, /INTELIGÊNCIA DE MERCADO/);
  assert.match(html, /GESTÃO DE RISCO/);
  assert.match(html, /PARECER DA IA/);
  assert.match(html, /BACKTEST AUTOMATIZADO/);
  assert.doesNotMatch(html, /experience\.js|preflight\.js/);
  assert.equal(fs.existsSync(path.join(root, 'src/sidepanel/experience.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/sidepanel/preflight.js')), false);
  for (const msg of ['ATS_CONNECT_ACTIVE_TAB','ATS_SET_SCANNER','ATS_PREPARE_TRADE','ATS_ACTIVATE_LICENSE','ATS_GET_STATE','ATS_SYNC_PLATFORM_PREFERENCES','ATS_RUN_BACKTEST','ATS_GET_WEEKLY_REPORT']) assert.ok(app.includes(msg));
  assert.match(app, /autoConnect/);
  assert.match(app, /CasaTrade sincronizada/);
  assert.match(app, /runtimePaused/);
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

test('network probe decodes websocket frames, reports quality and excludes secrets', () => {
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

test('generic adapter matches active asset, DOM/SVG catalog and structured network quote', () => {
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

test('weighted AI uses explicit factors, weights and profile thresholds', async () => {
  const scoring = read('src/core/ai-scoring.js');
  assert.match(scoring, /priceAction:25/);
  assert.match(scoring, /indicators:20/);
  assert.match(scoring, /emaTrend:15/);
  assert.match(scoring, /volatility:10/);
  assert.match(scoring, /correlation:10/);
  assert.match(scoring, /news:10/);
  assert.match(scoring, /momentum:10/);
  assert.match(scoring, /aggressive:65,balanced:75,aplus:85/);
  assert.match(scoring, /opinion/);
  const { weightedConfidence } = await import('../src/core/ai-scoring.js');
  const r = weightedConfidence({ direction:'BUY', profile:'balanced', structure:{ready:true,priceActionScore:90,trend:'up',breakout:'up'}, indicators:{rsi14:58,ema9:1.1,ema21:1.0,macd:{histogram:.1}}, candles:Array.from({length:20},(_,i)=>({open:1+i*.001,high:1.01+i*.001,low:.99+i*.001,close:1.005+i*.001})), confirmations:5,totalConfirmations:6, correlation:{score:85,alignment:'supportive'}, news:{blocked:false,minutesToNearest:120} });
  assert.ok(r.score >= 75);
  assert.equal(r.threshold, 75);
  assert.match(r.opinion, /Nota/);
});

test('multi-asset intelligence uses weighted AI, correlation and economic-event context', () => {
  const augment = read('src/background-augment.js');
  assert.match(augment, /intelligenceFrom/);
  assert.match(augment, /sessionContext/);
  assert.match(augment, /ia-ponderada-local/);
  assert.match(augment, /externalAi:'opcional'/);
  assert.match(augment, /correlationMatrix/);
  assert.match(augment, /strongestCorrelation/);
  assert.match(augment, /newsRisk/);
  assert.match(augment, /marketEvents/);
  assert.match(augment, /settings\.runtimePaused/);
  assert.match(augment, /ATS_RUN_BACKTEST/);
  assert.match(augment, /ATS_GET_WEEKLY_REPORT/);
});

test('risk engine protects bankroll and defines three profiles', () => {
  const risk = read('src/core/risk-controls.js');
  assert.match(risk, /conservative/);
  assert.match(risk, /moderate/);
  assert.match(risk, /aggressive/);
  assert.match(risk, /stakePct/);
  assert.match(risk, /Entrada excessiva em relação à banca/);
  assert.match(risk, /overtrading/i);
  assert.match(risk, /Meta diária de lucro atingida/);
  assert.match(risk, /bankHistory|appendBankSnapshot/);
});

test('chart overlay draws support resistance trend and EMAs without clicking the platform', () => {
  const overlay = read('src/content/chart-overlay.js');
  assert.match(overlay, /SUPORTE/);
  assert.match(overlay, /RESISTÊNCIA/);
  assert.match(overlay, /ema\(vals,9\)/);
  assert.match(overlay, /ema\(vals,21\)/);
  assert.match(overlay, /pointerEvents:'none'/);
  assert.doesNotMatch(overlay, /\.click\s*\(/);
});

test('backtest reports win rate pnl drawdown streaks profiles and setup type', () => {
  const backtest = read('src/core/backtest.js');
  for (const term of ['winRate','profitUnits','maxDrawdownUnits','bestWinStreak','worstLossStreak','conservative','moderate','aggressive','scalping','A+']) assert.match(backtest, new RegExp(term.replace('+','\\+')));
  assert.match(backtest, /analyzeCandles/);
  assert.match(backtest, /weightedConfidence/);
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

test('trade handoff highlights but never clicks the financial order', () => {
  const handoff = read('src/content/trade-handoff.js');
  assert.ok(handoff.includes('ATS_HIGHLIGHT_TRADE'));
  assert.ok(handoff.includes('scrollIntoView'));
  assert.doesNotMatch(handoff, /\.click\s*\(/);
  assert.doesNotMatch(handoff, /dispatchEvent\s*\(\s*new\s+MouseEvent/);
});

test('real recent candles seed analysis and scalping timeframes include M2', () => {
  const candles = read('src/core/candles.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(candles, /seed\(candles=\[\]\)/);
  assert.match(candles, /S5:5000/);
  assert.match(candles, /S15:15000/);
  assert.match(candles, /S30:30000/);
  assert.match(candles, /M2:120000/);
  assert.match(orchestrator, /builder\.seed\(snapshot\.candles\)/);
  assert.match(orchestrator, /weightedConfidence/);
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
