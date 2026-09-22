import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

export const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const manifest = () => JSON.parse(read('manifest.json'));

export function registerBuildContracts(label='build') {
  test(label + ': current extension package is the v0.11.56 video-15292 authority build', () => {
    const m = manifest();
    assert.equal(m.manifest_version, 3);
    assert.equal(m.version, '0.11.56');
    assert.equal(m.version_name, '0.11.56-video-15292-authority-final-window');
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
    assert.match(controls, /const invalidatedDeclared = realFresh && declared \? declared : null/);
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


export function registerVideo15290Contracts(label='video-15290') {
  test(label + ': final candidate survives one weak tick in both decision paths', () => {
    const central = read('src/core/orchestrator.js');
    const fast = read('src/core/live-fast-decision.js');
    assert.match(central, /FINAL_WEAK_HITS = 2/);
    assert.match(central, /cycle\.finalWeakHits/);
    assert.match(fast, /weakHits < 2/);
    assert.match(fast, /heldHits > 0/);
  });
  test(label + ': verified expiration survives a short CasaTrade control rerender', () => {
    const controls = read('src/background-platform-controls.js');
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(controls, /now - realExpirationAt < 15000/);
    assert.match(panel, /Date\.now\(\) - realAt < 15000/);
  });
  test(label + ': exact countdown UI rolls over without freezing at zero', () => {
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(panel, /duration \+ projected/);
    assert.match(panel, /elapsed <= 4/);
    assert.match(panel, /if \(!exactClockReady\(state\)\) return null/);
  });
  test(label + ': automatic refresh preserves an owned live session through a brief reader gap', () => {
    const control = read('src/background-control.js');
    assert.match(control, /sessionStillOwned/);
    assert.match(control, /briefReaderGap/);
    assert.match(control, /< 12000/);
  });
}


export function registerVideo15292Contracts(label='video-15292') {
  test(label + ': ambiguous multi-asset CasaTrade layouts cannot guess the active asset', () => {
    const focus = read('src/content/focused-asset-v2.js');
    const market = read('src/background-market-session.js');
    const policy = read('src/background-decision-policy.js');
    assert.match(focus, /if \(!first\.interaction && !first\.explicit\) return null/);
    assert.match(focus, /ambiguityCount/);
    assert.match(focus, /visualAuthority/);
    assert.match(market, /message\.visualAuthority === false/);
    assert.match(policy, /marketIdentityReady/);
    assert.match(policy, /marketIdentity\(state, signal\)/);
  });

  test(label + ': manual expiration can never unlock an actionable signal', () => {
    const controls = read('src/background-platform-controls.js');
    const policy = read('src/background-decision-policy.js');
    const panel = read('src/sidepanel/app-v2.js');
    const shell = read('src/sidepanel/ui-shell-v2.js');
    assert.match(controls, /ready = authority\.realFresh === true/);
    assert.match(policy, /Only a fresh, real CasaTrade observation may unlock execution/);
    assert.match(policy, /source !== 'user-declared'/);
    assert.match(panel, /expiration\.verified !== true/);
    assert.match(shell, /realExpirationAt/);
    assert.match(shell, /realExpirationSource/);
    assert.match(shell, /O campo manual não libera entrada/);
  });

  test(label + ': direct DOM probe publishes real expiration authority instead of promoting fallback', () => {
    const control = read('src/background-control.js');
    assert.match(control, /const realExpiration = exp\?\.expiration \|\| null/);
    assert.match(control, /realExpirationAt: realExpiration \? now/);
    assert.match(control, /realExpirationSource: realExpiration \? 'background-direct-dom'/);
    assert.match(control, /liveAuthority: !!realExpiration/);
    assert.match(control, /userDeclaredExpiration: realExpiration \? null/);
  });

  test(label + ': responsive expiration reader accepts label/value in either DOM order', () => {
    const direct = read('src/background-control.js');
    const observer = read('src/content/casatrade-ui-observer-v2.js');
    assert.match(direct, /const reversed = local\.match/);
    assert.match(observer, /const reversed = ctx\.match/);
    assert.match(observer, /neighborhood\(el, 4\)/);
  });

  test(label + ': short exact-clock gaps are bridged without authorizing the next candle', () => {
    const market = read('src/background-market-session.js');
    const policy = read('src/background-decision-policy.js');
    const panel = read('src/sidepanel/app-v2.js');
    assert.match(market, /CLOCK_FRESH_MS = 4500/);
    assert.match(policy, /CLOCK_FRESH_MS = 4500/);
    assert.match(policy, /projectedRemaining = Math\.max\(0/);
    assert.match(panel, /Date\.now\(\) - Number\(clock\.at\) < 4500/);
  });

  test(label + ': final hold inherits the technical candidate lifetime instead of restarting late', () => {
    const policy = read('src/background-decision-policy.js');
    assert.match(policy, /technicalPossibleSince/);
    assert.match(policy, /signal\.stability\?\.possibleSince/);
    assert.match(policy, /technicalSinceValid \? technicalPossibleSince : now/);
  });

  test(label + ': high numeric asset quality is never labeled poor solely because of range context', () => {
    const quality = read('src/core/asset-quality.js');
    assert.match(quality, /\|\| score >= 68/);
    assert.match(quality, /ATIVO EM OBSERVAÇÃO/);
  });
}


export function registerVideo15319Contracts(label='video-15319') {
  test(label + ': stale visual interaction cannot pin the previous asset', () => {
    const protocol = read('src/content/focused-asset-protocol.js');
    const focus = read('src/content/focused-asset-v2.js');
    const market = read('src/background-market-session.js');
    assert.match(protocol, /explicitTransition && age <= 2200/);
    assert.match(focus, /INTERACTION_TRANSITION_MS = 1800/);
    assert.match(focus, /Number\(b\.explicit\) - Number\(a\.explicit\)[\s\S]*Number\(b\.interaction\) - Number\(a\.interaction\)/);
    assert.match(market, /selectionLock\.at\) < 3500/);
  });

  test(label + ': expiration is read from embedded DOM and reversed canvas order', () => {
    const observer = read('src/content/casatrade-ui-observer-v2.js');
    const canvas = read('src/content/canvas-probe.js');
    assert.doesNotMatch(observer, /window !== window\.top/);
    assert.match(canvas, /const reversed = raw\.match/);
    assert.match(canvas, /Number\(m\[1\]\) \* 60/);
  });

  test(label + ': asset transition does not masquerade as a platform disconnect', () => {
    const market = read('src/background-market-session.js');
    assert.match(market, /const platformStillOnline/);
    assert.match(market, /connection: platformStillOnline \? 'online' : 'connecting'/);
    assert.match(market, /next\.price != null \|\| keepPlatformOnline \? 'online' : 'connecting'/);
  });

  test(label + ': radar copy is explicitly advisory', () => {
    const radar = read('src/sidepanel/market-radar-ui.js');
    assert.match(radar, /RADAR: MELHOR CENÁRIO/);
    assert.match(radar, /O Radar não troca o modo automaticamente/);
  });
}
