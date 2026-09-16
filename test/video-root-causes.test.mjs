import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('focused asset is sourced only from a trusted visible chart document', () => {
  const focus = read('src/content/focused-asset-v2.js');
  assert.match(focus, /if \(!traderHost\(host\) && !casaHost\(host\)\) return/);
  assert.match(focus, /const frameRole = traderHost\(host\) \? 'trader-frame' : 'casa-chart-frame'/);
  assert.match(focus, /function chartRect\(\)/);
  assert.match(focus, /function nearChart\(rect, chart\)/);
  assert.match(focus, /chartScoped: true/);
  assert.doesNotMatch(focus, /type:\s*'ATS_FOCUSED_ASSET'/);
});

test('ambiguous simultaneous asset labels are rejected while a recent chart selection can break the tie', () => {
  const focus = read('src/content/focused-asset-v2.js');
  assert.match(focus, /const second = winners\[1\] \|\| null/);
  assert.match(focus, /const minimumGap = first\.interaction \? 70 : first\.explicit \? 120 : 280/);
  assert.match(focus, /if \(gap < minimumGap\) return null/);
  assert.match(focus, /if \(listContext && !chartScoped\) continue/);
  assert.match(focus, /if \(!chartScoped\) continue/);
  assert.match(focus, /assets\.length !== 1/);
});

test('background accepts focus only from CasaTrade-owned charts or trusted legacy trader frames', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /const tabOwned = !!sender\.tab\?\.id && casaHost\(topHost\)/);
  assert.match(market, /const embeddedTrader = tabOwned && Number\(sender\.frameId\) !== 0 && traderHost\(frameHost\)/);
  assert.match(market, /const casaOwnedChart = tabOwned && casaHost\(frameHost\)/);
  assert.match(market, /trusted: embeddedTrader \|\| casaOwnedChart/);
  assert.match(market, /message\.chartScoped !== true/);
  assert.match(market, /message\.reliable !== true/);
  assert.match(market, /\['trader-frame', 'casa-chart-frame'\]\.includes\(role\)/);
  assert.match(market, /message\?\.type === 'ATS_VISUAL_FOCUS_V2'/);
});

test('asset, timeframe or frame switch hard-resets state that could leak the previous market', () => {
  const market = read('src/background-market-session.js');
  const start = market.indexOf('function resetForSession');
  const end = market.indexOf('\nfunction clockRecord', start);
  const reset = market.slice(start, end);
  for (const field of ["connection: 'connecting'",'price: null','candles: []','currentCandle: null','marketHistory: {}','signal: null','lastConfirmed: null','tradeIntent: null','lastSeen: null']) assert.ok(reset.includes(field), `missing reset field: ${field}`);
  assert.match(reset, /marketClock: null/);
  assert.match(reset, /resetOrchestrator\(\)/);
  assert.match(market, /session-integrity/);
});

test('clock v4 rejects purchase/duration timers and accepts bounded CasaTrade expiry countdown as candle boundary', () => {
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.match(clock, /if \(!traderHost\(host\) && !casaHost\(host\)\) return/);
  assert.match(clock, /focus\.trustedChartFrame !== true/);
  assert.match(clock, /hora de compra\|buy time\|entry time\|duration\|duracao/);
  assert.match(clock, /const expirySemantic = \/expira\|expiry\|expiration\/\.test\(context\)/);
  assert.match(clock, /clockMode: domClock\.expirySemantic \? 'platform-expiry-countdown'/);
  assert.match(clock, /if \(value\.seconds < 0 \|\| value\.seconds > limit \+ 2\) continue/);
  assert.match(clock, /clockRole: 'candle-close'/);
  assert.match(clock, /clockSource: 'trader-dom-countdown'/);
  assert.match(clock, /clockSource: 'platform-cycle-derived'/);
  assert.match(clock, /available: false, verified: false/);
  assert.doesNotMatch(clock, /function phaseCountdown/);
});

test('clock is accepted only from the same authoritative market and frame as visible focus', () => {
  const market = read('src/background-market-session.js');
  assert.match(market, /if \(!sameMarket\(clock\.asset, focus\.asset\)\) return null/);
  assert.match(market, /Number\(clock\.frameId\) !== Number\(focus\.frameId\)/);
  assert.match(market, /clean\(clock\.frameHost\).*clean\(focus\.frameHost\)/s);
  assert.match(market, /clean\(message\.clockRole\) === 'candle-close'/);
  assert.match(market, /message\.verified === true/);
});

test('missing or unverified CasaTrade clock removes actionable signal immediately', () => {
  const market = read('src/background-market-session.js');
  const start = market.indexOf('async function applyClock');
  const end = market.indexOf('\nasync function applyFeed', start);
  const clockHandler = market.slice(start, end);
  assert.match(clockHandler, /if \(!exact \|\| secondsRemaining == null \|\| secondsRemaining < 0\)/);
  assert.match(clockHandler, /signal: null/);
  assert.match(clockHandler, /stage: 'syncing_clock'/);
  assert.match(market, /CLOCK_FRESH_MS = 2600/);
});

test('exact clock is the heartbeat of bounded next-candle decisions', () => {
  const market = read('src/background-market-session.js');
  const orchestrator = read('src/core/orchestrator.js');
  assert.match(market, /function evaluateAtClock\(/);
  assert.match(market, /const processed = processSnapshot\(snapshot, state\)/);
  assert.match(market, /return evaluateAtClock\(clockState, focus, record\)/);
  assert.match(orchestrator, /function decisionWindows\(/);
  assert.match(orchestrator, /Math\.round\(duration \* \.25\)/);
  assert.match(orchestrator, /Math\.round\(duration \* \.067\)/);
  assert.match(orchestrator, /if \(secondsRemaining <= windows\.skip\)/);
  assert.match(orchestrator, /ANALYST_THRESHOLDS\.confirmScore/);
});

test('only overlay v2 is wired and it renders safe support/resistance plus one clock-gated trigger', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts.flatMap(row => row.js || []);
  assert.ok(scripts.includes('src/content/analysis-visual-overlay-v2.js'));
  assert.ok(!scripts.includes('src/content/analysis-visual-overlay.js'));
  const overlay = read('src/content/analysis-visual-overlay-v2.js');
  assert.match(overlay, /__ATS_ANALYSIS_VISUAL_OVERLAY__ = true/);
  assert.match(overlay, /function marketIntegrityOk\(\)/);
  assert.match(overlay, /function clockIntegrityOk\(\)/);
  assert.match(overlay, /if \(!clockIntegrityOk\(\)\) return null/);
  assert.match(overlay, /function fallbackLevels\(\)/);
  for (const label of ['Resistência relevante','Suporte relevante','Entrada COMPRA','Entrada VENDA']) assert.ok(overlay.includes(label), `missing overlay label ${label}`);
  for (const legacy of ['Preço atual','Gatilho compra','Gatilho venda','Aguardando:']) assert.ok(!overlay.includes(legacy), `legacy overlay clutter remained ${legacy}`);
  assert.match(overlay, /pointerEvents: 'none'/);
});

test('approved trading thresholds remain untouched in the current runtime', () => {
  const entry = read('src/background-entry.js');
  const analysis = read('src/core/analysis.js');
  assert.match(entry, /background-market-session\.js/);
  assert.doesNotMatch(entry, /background-integrity\.js/);
  assert.match(analysis, /possibleScore:\s*44/);
  assert.match(analysis, /confirmScore:\s*58/);
  assert.match(analysis, /candleStrength:\s*62/);
  assert.match(analysis, /rejectionStrength:\s*50/);
});
