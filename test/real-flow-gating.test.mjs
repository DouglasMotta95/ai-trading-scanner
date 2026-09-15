import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function section(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing section ${start}`);
  return source.slice(a, b);
}

test('market connection restores or validates cached license before live readers are injected', () => {
  const control = read('src/background-control.js');
  const connect = section(control, 'async function connectActiveTab()', 'async function activate(');
  assert.match(control, /restoreCachedLicense/);
  assert.match(control, /validateLicense/);
  assert.match(connect, /const license = await recoverLicense\(state\)/);
  assert.match(connect, /if \(!activeLicense\(license\)\)/);
  assert.match(connect, /await injectModern\(tab\.id\)/);
  assert.ok(connect.indexOf('if (!activeLicense(license))') < connect.indexOf('await injectModern(tab.id)'));
  assert.match(connect, /platform_not_registered/);
});

test('trade preparation remains confirmation-gated and manual-only', () => {
  const control = read('src/background-control.js');
  const handoff = read('src/content/trade-handoff.js');
  const manual = section(control, 'async function manualIntent', 'sidePanelSetBehavior');
  assert.match(manual, /if \(!confirmed \|\| signalDirection !== direction\) return \{ ok: false, error: 'signal_not_confirmed'/);
  assert.match(manual, /mode: 'manual-only'/);
  assert.match(control, /type === 'ATS_PREPARE_TRADE'/);
  assert.doesNotMatch(handoff, /\.click\s*\(/);
  assert.doesNotMatch(handoff, /dispatchEvent\s*\(\s*new\s+MouseEvent/);
});

test('activation preserves a valid cached session on transient device_locked', () => {
  const control = read('src/background-control.js');
  const license = read('src/services/license.js');
  const authoritative = license.match(/const AUTHORITATIVE_LICENSE_ERRORS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
  assert.match(control, /response\?\.error === 'device_locked'/);
  assert.match(control, /restoreCachedLicense\(\)/);
  assert.match(control, /syncPending: true/);
  assert.doesNotMatch(authoritative, /device_locked/);
  assert.match(authoritative, /device_limit_reached/);
});

test('visible chart frame stays authoritative and legacy market writers are ignored', () => {
  const focus = read('src/content/focused-asset-v2.js');
  const market = read('src/background-market-session.js');
  const control = read('src/background-control.js');
  const entry = read('src/background-entry.js');

  assert.match(focus, /__ATS_FOCUSED_ASSET_META__/);
  assert.match(focus, /reliable: true/);
  assert.match(focus, /chartScoped: true/);
  assert.match(focus, /const frameRole = traderHost\(host\) \? 'trader-frame' : 'casa-chart-frame'/);
  assert.match(focus, /candidateSamples >= 2 && stableFor >= 220/);

  assert.match(market, /const candidate = bestForFocus\(payload, asset\)/);
  assert.match(market, /if \(!candidate\) return/);
  assert.match(market, /const clock = exactClock\(state, info\)/);
  assert.match(market, /return evaluateAtClock\(clockState, focus, record\)/);
  assert.match(market, /session-integrity/);

  assert.match(control, /single_session_market_authority/);
  assert.match(control, /ATS_PLATFORM_SNAPSHOT/);
  assert.match(control, /ATS_NETWORK_DIAGNOSTIC/);
  assert.match(entry, /background-market-session\.js/);
  assert.doesNotMatch(entry, /background-augment\.js/);
  assert.doesNotMatch(entry, /background-integrity\.js/);
});
