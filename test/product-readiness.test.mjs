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
  assert.equal(JSON.parse(read('backend/package.json')).version, '0.11.49');
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

test('public health and extension download support HEAD checks', () => {
  const server = read('backend/src/server.js');
  assert.match(server, /pathname === '\/health'[\s\S]*?\['GET', 'HEAD'\]\.includes\(req\.method\)/);
  assert.match(server, /pathname === '\/download\/extension'[\s\S]*?\['GET', 'HEAD'\]\.includes\(req\.method\)/);
});


test('quota rollover and usage retry are server-backed instead of permanently cached', () => {
  const server = read('backend/src/server.js');
  const background = read('src/background.js');
  assert.match(server, /usageDay/);
  assert.match(background, /clean\(license\.usageDay\) === utcDay\(\)/);
  assert.match(background, /USAGE_RETRY_MS/);
  assert.match(background, /usageStatus: 'retry'/);
  assert.match(background, /setTimeout\(\(\) => scheduleAnalysis\(true\), USAGE_RETRY_MS \+ 250\)/);
});

test('confirmed-signal telemetry waits for exact entry and uses backend recorder fields', () => {
  const background = read('src/background.js');
  const server = read('backend/src/server.js');
  assert.match(background, /signalId: row\.signalId \|\| row\.id/);
  assert.match(background, /entryPrice: row\.entryPrice/);
  assert.match(background, /entryTime: row\.entryTime \?\? row\.targetStart/);
  assert.match(background, /usageStatus: 'consumed'/);
  assert.match(server, /const signalId = text\(d\.signalId/);
  assert.match(server, /entryPrice = num\(d\.entryPrice\)/);
  assert.match(server, /entryAt = num\(d\.entryTime\) \?\? evt\.at/);
});

test('customer package cannot enable OWNER_DEV through local settings', () => {
  const license = read('src/services/license.js');
  const owner = read('src/background-dev-owner.js');
  assert.match(license, /export const ownerDevMode = \(\) => false/);
  assert.doesNotMatch(license, /settings\?\.ownerDevMode === true/);
  assert.match(owner, /removeLegacyOwnerBypass/);
  assert.doesNotMatch(owner, /storageLocalGet\('settings'\)/);
});


test('signal usage is claimed in-flight and backend consumption is idempotent by signalId', () => {
  const background = read('src/background.js');
  const license = read('src/services/license.js');
  const server = read('backend/src/server.js');
  assert.match(background, /usageStatus: 'in_flight'/);
  assert.match(background, /USAGE_IN_FLIGHT_TIMEOUT_MS/);
  assert.match(background, /consumeSignal\(settings, row\.signalId \|\| row\.id\)/);
  assert.match(license, /signalId: String\(signalId \|\| ''\)/);
  assert.match(server, /license\.consumedSignals \?\?= \{\}/);
  assert.match(server, /license\.consumedSignals\[p\.signalId\]/);
  assert.match(server, /usageDuplicate: true/);
});

test('heartbeat forces server validation and blocks runtime on authoritative license failure', () => {
  const background = read('src/background.js');
  const license = read('src/services/license.js');
  assert.match(license, /forceServer = options\?\.forceServer === true/);
  assert.match(background, /validateLicense\(settings, \{ forceServer: true \}\)/);
  assert.match(background, /AUTHORITATIVE_LICENSE_ERRORS/);
  assert.match(background, /blockRuntimeForLicense/);
  assert.match(background, /scanner: 'idle'/);
  assert.match(background, /connection: 'offline'/);
  assert.match(background, /professionalDecision: null/);
});


test('video regression: possible can only publish with a final-entry-capable CasaTrade clock', () => {
  const background = read('src/background.js');
  const fastBg = read('src/background-fast-decision.js');
  const clock = read('src/content/market-cycle-clock-v4.js');
  assert.match(background, /clock\.verified !== true/);
  assert.match(background, /EXACT_CLOCK_SOURCES/);
  assert.match(fastBg, /exactClockReady\(observed\)/);
  assert.match(clock, /structured-candle-boundary/);
  assert.match(clock, /clockSource: 'network-server-cycle'/);
  assert.match(clock, /currentStateBoundary\(state, focus, cycleTf\)/);
});

test('video regression: declared expiration is a usable authority until CasaTrade disproves it', () => {
  const policy = read('src/background-decision-policy.js');
  const control = read('src/background-control.js');
  assert.match(policy, /guardActual/);
  assert.match(policy, /source === 'user-declared'/);
  assert.match(policy, /informada por você e aceita para este modo/);
  assert.match(control, /const preserveDeclaredExpiration = sameTabBeforeReconnect && sameConfirmedAsset/);
  assert.doesNotMatch(control, /const restartBase = enabled \? clearUserDeclaredExpirationState\(current\)/);
});

test('video regression: Gemini cannot remain loading after the primary entry disappears', () => {
  const ai = read('src/background-ai-analysis.js');
  const ui = read('src/sidepanel/ai-analysis-ui.js');
  assert.match(ai, /async function publishWaiting/);
  assert.match(ai, /if \(!stage\) \{[\s\S]*?await publishWaiting\(state\)/);
  assert.match(ui, /ai\.status === 'waiting'/);
});

test('operational panel does not count POSSIBLE events as entries', () => {
  const ui = read('src/sidepanel/ui-shell-v2.js');
  assert.doesNotMatch(ui, /POSSÍVEIS HOJE/);
  assert.match(ui, /ENTRADAS CONFIRMADAS/);
  assert.match(ui, /FINALIZADAS HOJE/);
  assert.match(ui, /state\.signalHistory/);
});


test('v0.11.49 market radar is additive and does not mutate the signal engine', () => {
  const html = read('src/sidepanel/index.html');
  const radar = read('src/sidepanel/market-radar-ui.js');
  assert.match(html, /market-radar-ui\.js/);
  assert.match(radar, /RADAR PRÉ-OPERAÇÃO/);
  assert.match(radar, /ANALISAR MERCADO AGORA/);
  assert.match(radar, /TEMPO REAL/);
  assert.match(radar, /aggregateM5/);
  assert.match(radar, /state\.marketHistory/);
  assert.doesNotMatch(radar, /processSnapshot|consumeSignal|ATS_SET_USER_DECLARED_EXPIRATION|ATS_SET_ANALYST_PREFERENCES/);
});

test('v0.11.49 entry safety check is visual only and asks for manual CasaTrade verification', () => {
  const radar = read('src/sidepanel/market-radar-ui.js');
  assert.match(radar, /CONFIRA A CASATRADE ANTES DE ENTRAR/);
  assert.match(radar, /Confira e ajuste manualmente antes de clicar na operação/);
  assert.match(radar, /ativo, timeframe e expiração/);
  assert.doesNotMatch(radar, /chrome\.tabs\.executeScript|scripting\.executeScript|click\(.*COMPRAR|click\(.*VENDER/);
});

test('v0.11.49 radar recommends M1 M5 or wait from captured candles only', () => {
  const radar = read('src/sidepanel/market-radar-ui.js');
  assert.match(radar, /recommendation = !best \|\| best\.quality < 55/);
  assert.match(radar, /'AGUARDAR'/);
  assert.match(radar, /PREFERIR/);
  assert.match(radar, /histórico real insuficiente/);
  assert.doesNotMatch(radar, /fetch\(/);
  assert.doesNotMatch(radar, /XMLHttpRequest|WebSocket/);
});

test('extension build is v0.11.49 market radar', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.version, '0.11.49');
  assert.equal(manifest.version_name, '0.11.49-market-radar');
});
