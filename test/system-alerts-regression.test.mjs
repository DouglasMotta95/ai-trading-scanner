import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');

test('manifest enables native notifications and offscreen audio without changing the M1 core', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.permissions.includes('notifications'));
  assert.ok(manifest.permissions.includes('offscreen'));
  assert.equal(manifest.icons?.['128'], 'src/assets/icon128.png');
  assert.match(read('src/background-entry.js'), /background-system-alerts\.js/);
});

test('system alerts are limited to M1 60s pre-signal and final decision windows with per-candle dedupe', () => {
  const source = read('src/background-system-alerts.js');
  assert.match(source, /decision\.timeReady !== true \|\| decision\.expirationReady !== true/);
  assert.match(source, /decision\.timeframe.*M1/);
  assert.match(source, /decision\.actualExpiration.*60s/);
  assert.match(source, /seconds > 10/);
  assert.match(source, /POSSIBLE_BUY/);
  assert.match(source, /seconds <= 0 \|\| seconds > 30/);
  assert.match(source, /ui === 'ENTER_BUY'/);
  assert.match(source, /ui === 'ENTER_SELL'/);
  assert.match(source, /'AGUARDAR'/);
  assert.match(source, /atsSystemAlertLedgerV1/);
  assert.match(source, /claimCycleStage/);
  assert.match(source, /chrome\.notifications\.create/);
  assert.match(source, /chrome\.sidePanel\.open/);
});

test('notification and sound preferences persist in the existing sidepanel preferences store', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app-v2.js');
  assert.match(html, /id="notificationToggle"/);
  assert.equal((html.match(/id="alertLevel"/g) || []).length, 1);
  assert.match(app, /notificationsEnabled:\s*true/);
  assert.match(app, /setPref\('notificationsEnabled'/);
  assert.match(app, /DEFAULT_PREFS\.alertLevel/);
  assert.doesNotMatch(app, /maybeSound\(state, model\);/);
});

test('offscreen Web Audio provides different tones for pre-signal and final decision', () => {
  const source = read('src/offscreen/alert-audio.js');
  assert.match(source, /kind === 'pre'/);
  assert.match(source, /tone\(650/);
  assert.match(source, /tone\(820/);
  assert.match(source, /tone\(760/);
  assert.match(source, /tone\(980/);
  assert.match(source, /tone\(1180/);
});
