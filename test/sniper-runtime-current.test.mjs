import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessAssetQuality } from '../src/core/asset-quality.js';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const entry = read('src/background-entry.js');
const engine = read('src/background-sniper-engine.js');
const injector = read('src/background-sniper-injector.js');
const bridge = read('src/content/embedded-feed-bridge.js');
const assetObserver = read('src/content/casatrade-asset-observer.js');
const controlsObserver = read('src/content/casatrade-controls-observer.js');
const opaqueProxy = read('src/background-opaque-frame-proxy.js');
const liveClock = read('src/content/casatrade-live-clock.js');
const bootstrap = read('src/content/sniper-page-bootstrap.js');
const panel = read('src/sidepanel/app-v2.js');
const html = read('src/sidepanel/index.html');
const manifest = JSON.parse(read('manifest.json'));
const cycle = read('src/core/sniper-cycle.js');
const results = read('src/background-sniper-results.js');
const license = read('src/services/license.js');
const ai = read('src/background-ai-analysis.js');

test('runtime loads the Sniper authority plus Gemini second reading without competing decision engines', () => {
  assert.match(entry, /background-sniper-engine\.js/);
  assert.match(entry, /background-ai-analysis\.js/);
  for (const old of ['background-market-session.js','background-fast-decision.js','background-decision-policy.js','background-radar.js','background-shadow-calibration.js']) {
    assert.doesNotMatch(entry, new RegExp(old.replaceAll('.', '\\.')));
  }
});

test('Sniper authority binds focus, numeric OHLC and CasaTrade clock to the same market', () => {
  assert.match(engine, /ATS_VISUAL_FOCUS_V2/);
  assert.match(engine, /ATS_EMBEDDED_FEED/);
  assert.match(engine, /ATS_MARKET_CLOCK_V2/);
  assert.match(engine, /sameAsset\(focus\.asset, asset\)/);
  assert.match(engine, /Number\(focus\.frameId\) !== info\.frameId/);
  assert.match(engine, /normalizeCandles/);
  assert.match(engine, /message\.clockRole !== 'candle-close'/);
  assert.match(engine, /new Set\(\['casatrade-platform-clock'\]\)/);
});

test('visible chart is primary focus and stable selected network data is only a recovery path', () => {
  assert.match(assetObserver, /shadowRoot/);
  assert.match(assetObserver, /nearChartHeader/);
  assert.match(assetObserver, /visible-selected/);
  assert.match(assetObserver, /user-selection/);
  assert.match(bridge, /uniqueSelected/);
  assert.match(bridge, /network-bootstrap-selected/);
  assert.match(bridge, /network-stable-fallback/);
  assert.match(bridge, /selected\.hits >= 5/);
  assert.match(bridge, /feedQuality\(payload\) < \.8/);
  assert.match(bridge, /filter\(row => asset\(row\?\.asset\) === wanted\)/);
});

test('opaque Android chart frames relay focus feed clock and controls through CasaTrade top frame', () => {
  assert.match(opaqueProxy, /ATS_VISUAL_FOCUS_V2/);
  assert.match(opaqueProxy, /ATS_EMBEDDED_FEED/);
  assert.match(opaqueProxy, /ATS_MARKET_CLOCK_V2/);
  assert.match(opaqueProxy, /ATS_PLATFORM_CONTROLS_OBSERVED/);
  assert.match(opaqueProxy, /ATS_OPAQUE_FRAME_FORWARD/);
  assert.match(assetObserver, /ATS_OPAQUE_FRAME_PROXY/);
  assert.match(controlsObserver, /ATS_OPAQUE_FRAME_PROXY/);
});

test('CasaTrade visible countdown plus OHLC boundary is the live candle clock', () => {
  assert.match(liveClock, /bestDomCountdown/);
  assert.match(liveClock, /dom-countdown/);
  assert.match(liveClock, /sourceNow = closeAt - candidate\.seconds \* 1000/);
  assert.match(liveClock, /clockSource: 'casatrade-platform-clock'/);
  assert.match(liveClock, /ATS_PLATFORM_CONTROLS_OBSERVED/);
  assert.doesNotMatch(liveClock, /sourceNow\s*\|\|\s*Date\.now/);
  assert.doesNotMatch(liveClock, /epochAtAnchor:\s*Date\.now/);
  assert.match(bridge, /const sourceNow = timestamp\(candidate\.timestamp \?\? candidate\.time \?\? candidate\.serverTime\)/);
  assert.match(engine, /serverTime: sourceNow/);
  assert.match(engine, /authoritativeNow\(clock\)/);
});

test('asset switch clears the prior market session before accepting the new market', () => {
  assert.match(engine, /cycles\.clear\(\)/);
  assert.match(engine, /resetLegacyAnalyzer\(\)/);
  assert.match(engine, /resetMarketSession/);
  assert.match(engine, /Cache anterior limpo/);
});

test('Sniper cycle implements prepare at 30 seconds and final decision at 10 seconds without legacy skip state', () => {
  assert.match(cycle, /prepareAt\s*:\s*30/);
  assert.match(cycle, /executeAt\s*:\s*10/);
  assert.match(engine, /POSSÍVEL/);
  assert.match(engine, /ENTRAR NA PRÓXIMA VELA/);
  assert.match(engine, /SEM ENTRADA NESTA VELA/);
  assert.match(engine, /cycle\.locked = 'ENTER'/);
  assert.match(engine, /cycle\.locked = 'NO_ENTRY'/);
  assert.doesNotMatch(engine, /PULAR PRÓXIMA VELA/);
  assert.doesNotMatch(engine, /uiState:\s*'SKIP'/);
  assert.doesNotMatch(panel, /PULAR PRÓXIMA VELA/);
  assert.doesNotMatch(html, /ENTRAR \/ PULAR/);
});

test('final confirmation requires real feed quality, CasaTrade expiration and deduplicated observations', () => {
  assert.match(engine, /MIN_FEED_QUALITY = 0\.8/);
  assert.match(engine, /normalizeFeedQuality\(payload\.feedQuality\)/);
  assert.doesNotMatch(engine, /normalizeFeedQuality\(candidate\.confidence\)/);
  assert.match(engine, /MIN_HIT_INTERVAL_MS = 700/);
  assert.match(engine, /blockedBy: 'expiration'/);
  assert.match(engine, /expirationReady: expiration\.ready/);
  assert.match(bridge, /lastSignature/);
});

test('strong recent local opportunity is not labeled as a poor asset just because the broad regime is range', () => {
  const candles = [
    { open: 1.000, high: 1.012, low: .998, close: 1.010 },
    { open: 1.010, high: 1.022, low: 1.008, close: 1.020 },
    { open: 1.020, high: 1.034, low: 1.018, close: 1.032 },
    { open: 1.032, high: 1.044, low: 1.030, close: 1.042 },
    { open: 1.042, high: 1.056, low: 1.040, close: 1.054 }
  ];
  const quality = assessAssetQuality({
    asset: 'EUR/USD (OTC)',
    candles,
    signal: {
      analysisDirection: 'BUY',
      analysisScore: 62,
      uiState: 'BUILDING_PATTERN',
      regime: { type: 'range' },
      analytics: {
        buyPower: 68, sellPower: 32,
        currentStrength: 70,
        momentumDirection: 'BUY', momentumScore: 65,
        continuationDirection: 'BUY', continuationScore: 68,
        trendDirection: 'BUY'
      }
    }
  });
  assert.notEqual(quality.status, 'POOR');
  assert.notEqual(quality.label, 'ATIVO RUIM PARA OPERAR');
  assert.equal(quality.bias, 'COMPRADOR');
});

test('confirmation is blocked on extreme volatility or feed quality below 80 percent', () => {
  assert.match(engine, /signal\.regime\?\.extremeVolatility === true/);
  assert.match(engine, /feedQuality < MIN_FEED_QUALITY/);
  assert.match(engine, /confirmationFeedGate/);
  assert.match(engine, /minimum: 80/);
});

test('Android and Quetta injection has callback compatibility, script-tag fallback and staged watchdog', () => {
  assert.match(injector, /chrome\.scripting\.executeScript/);
  assert.match(injector, /returned\?\.then/);
  assert.match(injector, /script-tag-fallback/);
  assert.match(injector, /asset_timeout/);
  assert.match(injector, /ohlc_timeout/);
  assert.match(injector, /clock_timeout/);
  assert.match(injector, /scheduleWatchdog/);
  assert.match(bootstrap, /page-world-confirmed/);
  assert.match(bootstrap, /ATS_PAGE_WORLD_SENTINEL/);
});

test('trade result runtime is present and resolves the locked target candle as WIN LOSS or DRAW', () => {
  assert.match(entry, /background-sniper-results\.js/);
  assert.match(results, /WIN/);
  assert.match(results, /LOSS/);
  assert.match(results, /DRAW/);
  assert.match(results, /targetEnd/);
});

test('sidepanel order is asset quality then decision then Gemini and trade result', () => {
  const quality = html.indexOf('id="assetQualityCard"');
  const decision = html.indexOf('id="decision"');
  const gemini = html.indexOf('id="aiAuditCard"');
  const result = html.indexOf('ÚLTIMA OPERAÇÃO');
  assert.ok(quality >= 0 && decision > quality && gemini > decision && result > gemini);
  assert.match(html, /asset-quality-ui\.js/);
  assert.match(html, /ai-analysis-ui\.js/);
  assert.match(ai, /clock\.source !== 'casatrade-platform-clock'/);
});

test('unpacked owner development mode remains separate from customer licensing', () => {
  assert.match(license, /OWNER_DEV/);
  assert.match(license, /ownerDevMode/);
  assert.match(license, /testLicenseBlock/);
});

test('manifest remains MV3 side-panel extension and loads current Sniper capture scripts', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html');
  assert.equal(manifest.action?.default_popup, undefined);
  const scripts = (manifest.content_scripts || []).flatMap(row => row.js || []);
  assert.ok(scripts.includes('src/content/casatrade-asset-observer.js'));
  assert.ok(scripts.includes('src/content/casatrade-live-clock.js'));
  assert.ok(scripts.includes('src/content/embedded-feed-bridge.js'));
  assert.ok(scripts.includes('src/content/network-probe.js'));
  assert.ok(scripts.includes('src/content/sniper-page-bootstrap.js'));
});
