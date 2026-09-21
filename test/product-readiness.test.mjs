import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('sidepanel loads customer account connector and uses refresh backoff', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  const bg = read('src/background.js');
  assert.match(html, /account-login\.js/);
  assert.match(app, /accountManaged/);
  assert.match(app, /RECONNECT_DELAYS_MS/);
  assert.match(app, /ATS_REFRESH_MARKET/);
  assert.match(bg, /message\?\.type === 'ATS_REFRESH_MARKET'/);
});

test('extension settings expose the real 44 and 58 thresholds instead of fake profiles', () => {
  const html = read('src/admin/index.html');
  const js = read('src/admin/admin.js');
  assert.match(html, /score mínimo 44/);
  assert.match(html, /score mínimo 58/);
  assert.doesNotMatch(html, /Conservador|Agressivo/);
  assert.match(js, /preSignalScore: 44/);
  assert.match(js, /confirmScore: 58/);
  assert.doesNotMatch(js, /PROFILE_SCORE/);
  assert.match(js, /profile: _profile, minScore: _minScore, onlyA: _onlyA/);
});

test('backend requires strong production session secret and serializes payment processing', () => {
  const server = read('backend/src/server.js');
  assert.match(server, /SESSION_SECRET/);
  assert.match(server, /at least 32 characters in production/);
  assert.match(server, /paymentLocks/);
  assert.match(server, /orderLocks/);
  assert.match(server, /setPaymentEvent\(eventKey, 'processing'/);
  assert.match(server, /await processPayment\(paymentId\)/);
  assert.match(server, /setPaymentEvent\(eventKey, 'completed'/);
  assert.match(server, /admin-login', 5, 60000/);
  assert.match(server, /duplicateOrder/);
  assert.equal(JSON.parse(read('backend/package.json')).version, '0.11.47');
});

test('customer portal escapes plan labels and exposes recovery/legal surfaces', () => {
  const app = read('apps/customer-portal/app.js');
  const html = read('apps/customer-portal/index.html');
  assert.match(app, /escHtml/);
  assert.match(app, /forgot-password/);
  assert.match(app, /reset-password/);
  assert.match(html, /href="\/privacy"/);
  assert.match(html, /href="\/terms"/);
  assert.match(html, /id="forgotPassword"/);
});