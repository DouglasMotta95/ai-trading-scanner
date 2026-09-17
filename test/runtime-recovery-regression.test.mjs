import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('focused asset and direct scan reach inherited-origin child frames', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const row = manifest.content_scripts.find(x => x.js?.length === 1 && x.js[0] === 'src/content/focused-asset.js');
  const background = read('src/background.js');
  const augment = read('src/background-augment.js');
  assert.equal(row?.all_frames, true);
  assert.equal(row?.match_origin_as_fallback, true);
  assert.match(background, /focused-asset\.js'.*allFrames: true/);
  assert.match(background, /Child frames may be about:blank\/srcdoc/);
  assert.doesNotMatch(augment, /sender\.frameId !== 0/);
  assert.match(augment, /isCasaTradeHost\(topHost\)/);
});

test('strong network evidence can bootstrap asset before focus without overriding a real focus', () => {
  const bridge = read('src/content/network-bridge.js');
  assert.match(bridge, /confidence \|\| 0\) >= 82/);
  assert.match(bridge, /const resolvedAsset = focus \|\| candidate\.asset/);
  assert.match(bridge, /if \(focus && !sameAsset\(candidate\.asset, focus\)\) return/);
  assert.match(bridge, /focusFallback: !focus/);
});

test('corroborated DOM evidence can clear the Phase C floor while weak DOM remains below it', () => {
  const background = read('src/background.js');
  assert.match(background, /assetPriceCorroborated === true\) return 85/);
  assert.match(background, /return state\.asset && state\.price != null \? 65 : 0/);
  assert.match(background, /confirmationFeedQuality < 80/);
});

test('account refresh preserves prior non-empty license key and stable runtime identity remains intact', () => {
  const account = read('src/sidepanel/account-login.js');
  const telemetry = read('src/services/telemetry.js');
  assert.match(account, /previous\[LICENSE_KEY\]/);
  assert.match(account, /resolvedLicenseKey/);
  assert.match(telemetry, /stableRuntimeInstallationId/);
  assert.match(telemetry, /const id = stableId \|\| existing \|\| randomInstallationId\(\)/);
});
