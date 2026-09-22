import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

export const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const manifest = () => JSON.parse(read('manifest.json'));

export function registerBuildContracts(label='build') {
  test(label + ': current extension package is the v0.11.55 video-15290 stability build', () => {
    const m = manifest();
    assert.equal(m.manifest_version, 3);
    assert.equal(m.version, '0.11.55');
    assert.equal(m.version_name, '0.11.55-video15290-stability');
    assert.equal(m.background?.service_worker, 'src/background-entry.js');
    assert.equal(m.side_panel?.default_path, 'src/sidepanel/index.html');
  });
  test(label + ': current CasaTrade readers are packaged', () => {
    const files = manifest().content_scripts.flatMap(row => row.js || []);
    for (const required of ['src/content/focused-asset-v2.js','src/content/embedded-feed-bridge.js','src/content/market-cycle-clock-v4.js','src/content/casatrade-expiration-probe.js','src/content/account-metrics-observer.js','src/content/trade-handoff-v2.js']) assert.ok(files.includes(required), 'missing ' + required);
  });
}

export function registerMarketContracts(label='market') {
  test(label + ': visible CasaTrade focus is the market authority', () => {
    const focus = read('src/content/focused-asset-v2.js');
    const market = read('src/background-market-session.js');
    assert.match(focus, /ATS_VISUAL_FOCUS_V2/);
    assert.match(focus, /chartScoped: true/);
    assert.match(focus, /reliable: true/);
    assert.match(focus, /schedulePublish\(260, false\)/);
    assert.match(market, /message\?\.type === 'ATS_VISUAL_FOCUS_V2'/);
    assert.match(market, /trusted: embeddedTrader \|\| casaOwnedChart/);
    assert.match(market, /pendingAsset: toAsset/);
    assert.match(market, /confirmedAsset: asset/);
  });
  test(label + ': an asset switch clears stale operational market data', () => {
    const market = read('src/background-market-session.js');
    const start = market.indexOf('function resetForSession');
    const end = market.indexOf('function clockRecord', start);
    const reset = market.slice(start, end);
    for (const field of ['price: null','candles: []','marketHistory: {}','signal: null','professionalDecision: null','lastConfirmed: null','lastSeen: null']) assert.ok(reset.includes(field), 'missing reset field ' + field);
  });
  test(label + ': technical analysis has one runtime owner', () => {
    const background = read('src/background.js');
    const market = read('src/background-market-session.js');
    assert.match(background, /Single owner of technical analysis/);
    assert.match(background, /processSnapshot\(snapshot, current\)/);
    assert.doesNotMatch(market, /processSnapshot\(/);
  });
}

export function registerTimeContracts(label='time') {
  test(label + ': exact CasaTrade clock sources remain authoritative', () => {
    const policy = read('src/background-decision-policy.js');
    const control = read('src/background-control.js');
    const clock = read('src/content/market-cycle-clock-v4.js');
    for (const source of ['trader-dom-countdown','network-server-cycle']) {
      assert.match(policy, new RegExp(source));
      assert.match(control, new RegExp(source));
      assert.match(clock, new RegExp(source));
    }
    assert.match(clock, /clockRole: 'candle-close'/);
    assert.doesNotMatch(clock, /\|\|\s*'M1'/);
  });
  test(label + ': panel never fabricates a countdown', () => {
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(panel, /if \(!exactClockReady\(state\)\) return null/);
    assert.match(panel, /setText\('timeSyncStatus', exact \? 'EXATO • CASATRADE' : 'PENDENTE'\)/);
    assert.doesNotMatch(panel, /COUNTDOWN ESTIMADO/);
  });
  test(label + ': active operation mode is a single M1 or M5 authority', () => {
    const panel = read('src/sidepanel/app-v2.js');
    const analysis = read('src/core/analysis.js');
    assert.match(panel, /state\?\.analystPreferences\?\.operationMode/);
    assert.match(panel, /setText\('timeframe'.*operation\.timeframe/);
    assert.match(analysis, /timeframe: 'M5'[\s\S]*expiration: '300s'/);
    assert.match(analysis, /timeframe: 'M1'[\s\S]*expiration: '60s'/);
  });
}

export function registerExpirationContracts(label='expiration') {
  test(label + ': real CasaTrade expiration supersedes and invalidates manual fallback', () => {
    const controls = read('src/background-platform-controls.js');
    assert.match(controls, /const invalidatedDeclared = realKnown && declared \? declared : null/);
    assert.match(controls, /const effectiveDeclared = invalidatedDeclared \? null : declared/);
    assert.match(controls, /userDeclaredExpiration: resolved\.authority\.invalidatedDeclared \? null/);
    assert.match(controls, /manualInvalidated: authority\.invalidatedDeclared \|\| null/);
  });
  test(label + ': expiration is an execution gate for the active M1\/M5 mode', () => {
    const policy = read('src/background-decision-policy.js');
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(policy, /Expiration is an execution gate/);
    assert.match(policy, /operationMode\.expiration/);
    assert.match(panel, /expiration\.value !== operation\.expiration/);
    assert.match(panel, /AJUSTE A EXPIRAÇÃO DA CASATRADE/);
  });
}

export function registerUiContracts(label='ui') {
  test(label + ': primary panel keeps one decision surface and live market fields', () => {
    const html = read('src/sidepanel/index.html');
    for (const id of ['connectScanner','asset','timeframe','heroExpiration','heroCountdown','decisionCard','decisionText','prepareBuy','prepareSell','recentCandles','advancedPanel']) assert.ok(html.includes('id="' + id + '"'));
    assert.equal((html.match(/id=["']decisionCard["']/g) || []).length, 1);
  });
  test(label + ': M1 and M5 settings are shown from the same operation selector', () => {
    const html = read('src/sidepanel/index.html');
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(html, /id="operationMode"/);
    assert.match(html, /value="M1"/);
    assert.match(html, /value="M5"/);
    assert.match(panel, /function syncSettingsUi\(state = null\)/);
    assert.match(panel, /scannerModeHeading/);
    assert.match(panel, /operationTimeframeDisplay/);
  });
  test(label + ': cached asset is hidden until a fresh panel-boot focus arrives', () => {
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(panel, /focusConfirmedThisPanel/);
    assert.match(panel, /bootAwaitingFocus/);
    assert.match(panel, /ATS_REFRESH_MARKET/);
    assert.match(panel, /ATUALIZANDO…/);
  });
}

export function registerOhlcContracts(label='ohlc') {
  test(label + ': panel exposes current OHLC and the last ten real candles', () => {
    const html = read('src/sidepanel/index.html');
    const panel = read('src/sidepanel/app-v2.js');
    for (const id of ['currentOpen','currentHigh','currentLow','currentClose','recentCandleCount','recentCandles']) assert.ok(html.includes('id="' + id + '"'));
    assert.match(panel, /slice\(-10\)/);
    assert.match(panel, /structured-casatrade/);
    assert.match(panel, /live-price-observed/);
  });
}

export function registerGeminiContracts(label='gemini') {
  test(label + ': Gemini remains a second reading after technical/time gates', () => {
    const html = read('src/sidepanel/index.html');
    const ai = read('src/background-ai-analysis.js');
    assert.match(html, /GEMINI • SEGUNDA LEITURA/);
    assert.match(html, /Motor técnico primário é autoritativo/);
    assert.match(ai, /professionalDecision\?\.timeReady !== true/);
    assert.match(ai, /professionalDecision\?\.expirationReady !== true/);
    assert.match(ai, /geminiEnabled === false/);
  });
}

export function registerManualContracts(label='manual') {
  test(label + ': execution stays manual with no automatic CasaTrade click', () => {
    const handoff = read('src/content/trade-handoff-v2.js');
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(handoff, /ATS_HIGHLIGHT_TRADE/);
    assert.doesNotMatch(handoff, /\.click\s*\(/);
    assert.doesNotMatch(handoff, /dispatchEvent\s*\(\s*new\s+MouseEvent/);
    assert.match(panel, /model\.actionable && model\.direction === 'BUY' && timeReady/);
    assert.match(panel, /model\.actionable && model\.direction === 'SELL' && timeReady/);
  });
}

export function registerRadarContracts(label='radar') {
  test(label + ': market radar is presentation-only and cannot execute signals', () => {
    const html = read('src/sidepanel/index.html');
    const radar = read('src/sidepanel/market-radar-ui.js');
    assert.match(html, /market-radar-ui\.js/);
    assert.doesNotMatch(radar, /processSnapshot|consumeSignal|ATS_SET_USER_DECLARED_EXPIRATION/);
    assert.doesNotMatch(radar, /\.click\s*\(.*COMPRAR|\.click\s*\(.*VENDER/);
  });
}

export function registerVideo15290Contracts(label='video-15290') {
  test(label + ': final-window weak ticks do not erase the first strong confirmation', async () => {
    const { fastLiveDecision, resetFastLiveDecision } = await import('../src/core/live-fast-decision.js');
    const targetStart = 1_700_000_120_000;
    const strong = {
      state: 'WATCH', uiState: 'POSSIBLE_SELL', direction: 'SELL', analysisDirection: 'SELL',
      score: 84, analysisScore: 84,
      analytics: {
        buyPower: 30, sellPower: 70, currentStrength: 72,
        momentumDirection: 'SELL', momentumScore: 62,
        continuationDirection: 'SELL', continuationScore: 67,
        rejectionDirection: 'SELL', rejectionStrength: 55
      }
    };
    const weak = { ...strong, analytics: { ...strong.analytics, sellPower: 52 } };
    resetFastLiveDecision();
    const first = fastLiveDecision(strong, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', operationMode: 'M1', secondsRemaining: 5, targetStart, serverTime: 1_700_000_115_000 });
    assert.equal(first.uiState, 'POSSIBLE_SELL');
    const jitter = fastLiveDecision(weak, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', operationMode: 'M1', secondsRemaining: 4, targetStart, serverTime: 1_700_000_115_700 });
    assert.equal(jitter.uiState, 'POSSIBLE_SELL');
    assert.equal(jitter.confirmationHeld, true);
    const second = fastLiveDecision(strong, { asset: 'AUD/CAD (OTC)', timeframe: 'M1', operationMode: 'M1', secondsRemaining: 3, targetStart, serverTime: 1_700_000_116_400 });
    assert.equal(second.uiState, 'ENTER_SELL');
  });

  test(label + ': rollover releases stale zero instead of pinning 0s', () => {
    const clock = read('src/content/market-cycle-clock-v4.js');
    const market = read('src/background-market-session.js');
    assert.match(clock, /staleZeroClock/);
    assert.match(clock, /canvasZeroExpired/);
    assert.match(clock, />= 850/);
    assert.match(market, /const staleZeroClock = !!previousClock/);
    assert.match(market, /previousAge >= 850/);
  });

  test(label + ': automatic refresh preserves a linked same-tab session', () => {
    const control = read('src/background-control.js');
    const shell = read('src/sidepanel/ui-shell-v2.js');
    assert.match(control, /const automaticSameSession = automatic && sameTab/);
    assert.match(control, /if \(!\(automatic && next\.connection === 'online'\)\) scheduleConnectionTimeout/);
    assert.match(shell, /function linkedSession\(state = \{\}\)/);
    assert.match(shell, /const sessionLinked = linkedSession\(state\)/);
  });

  test(label + ': real expiration cache cannot become an unsafe entry authority', () => {
    const controls = read('src/background-platform-controls.js');
    const policy = read('src/background-decision-policy.js');
    assert.match(controls, /REAL_EXPIRATION_READY_MS = 7000/);
    assert.match(controls, /REAL_EXPIRATION_CACHE_MS = 15000/);
    assert.match(controls, /const realKnown =/);
    assert.match(controls, /const authorityReady = authority\.source === 'user-declared' \|\| authority\.realFresh/);
    assert.match(policy, /const ready = actual === operationMode\.expiration && \(manualFallback \|\| verified\)/);
  });
}

export function registerAudioContracts(label='audio') {
  test(label + ': mobile alerts keep off\/discrete\/strong levels and haptics', () => {
    const html = read('src/sidepanel/index.html');
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(html, /id="alertLevel"/);
    assert.match(html, /value="off"/);
    assert.match(html, /value="discrete"/);
    assert.match(html, /value="strong"/);
    assert.match(panel, /navigator\?\.vibrate/);
    assert.match(panel, /function play\(kind\)/);
  });
}
