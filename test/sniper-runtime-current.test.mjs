import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const entry = read('src/background-entry.js');
const engine = read('src/background-sniper-engine.js');
const manifest = JSON.parse(read('manifest.json'));
const cycle = read('src/core/sniper-cycle.js');
const results = read('src/background-sniper-results.js');
const license = read('src/services/license.js');

test('runtime loads one Sniper market/decision authority and excludes competing engines', () => {
  assert.match(entry, /background-sniper-engine\.js/);
  for (const old of ['background-market-session.js','background-fast-decision.js','background-decision-policy.js','background-radar.js','background-ai-analysis.js','background-shadow-calibration.js']) {
    assert.doesNotMatch(entry, new RegExp(old.replaceAll('.', '\\.')));
  }
});

test('Sniper authority binds focus, numeric OHLC and exact clock to the same visible market', () => {
  assert.match(engine, /ATS_VISUAL_FOCUS_V2/);
  assert.match(engine, /ATS_EMBEDDED_FEED/);
  assert.match(engine, /ATS_MARKET_CLOCK_V2/);
  assert.match(engine, /sameAsset\(focus\.asset,asset\)/);
  assert.match(engine, /Number\(focus\.frameId\)!==info\.frameId/);
  assert.match(engine, /normalizeCandles/);
  assert.match(engine, /clockRole!=='candle-close'/);
  assert.match(engine, /EXACT_CLOCK_SOURCES/);
});

test('asset switch clears the prior market session before accepting the new visible asset', () => {
  assert.match(engine, /cycles\.clear\(\)/);
  assert.match(engine, /resetLegacyAnalyzer\(\)/);
  assert.match(engine, /resetMarketSession/);
  assert.match(engine, /Cache anterior limpo/);
});

test('Sniper cycle implements prepare at 30 seconds and final decision at 10 seconds', () => {
  assert.match(cycle, /prepareAt\s*:\s*30/);
  assert.match(cycle, /executeAt\s*:\s*10/);
  assert.match(engine, /POSSÍVEL/);
  assert.match(engine, /ENTRAR NA PRÓXIMA VELA/);
  assert.match(engine, /PULAR PRÓXIMA VELA/);
  assert.match(engine, /cycle\.locked='ENTER'/);
  assert.match(engine, /cycle\.locked='SKIP'/);
});

test('trade result runtime is present and resolves the locked target candle as WIN LOSS or DRAW', () => {
  assert.match(entry, /background-sniper-results\.js/);
  assert.match(results, /WIN/);
  assert.match(results, /LOSS/);
  assert.match(results, /DRAW/);
  assert.match(results, /targetEnd/);
});

test('unpacked owner development mode remains separate from customer licensing', () => {
  assert.match(license, /OWNER_DEV/);
  assert.match(license, /ownerDevMode/);
  assert.match(license, /testLicenseBlock/);
});

test('manifest remains MV3 side-panel extension and loads current Sniper capture scripts', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.side_panel?.default_path, 'src/sidepanel/index.html');
  const scripts = (manifest.content_scripts || []).flatMap(row => row.js || []);
  assert.ok(scripts.includes('src/content/asset-observer.js'));
  assert.ok(scripts.includes('src/content/casatrade-platform-clock.js'));
  assert.ok(scripts.includes('src/content/network-probe.js'));
});
