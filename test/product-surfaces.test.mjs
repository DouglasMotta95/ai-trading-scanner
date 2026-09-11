import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('public portal exposes verification recovery, code copy and risk disclosure', () => {
  const html = read('apps/customer-portal/index.html');
  const app = read('apps/customer-portal/app.js');
  const css = read('apps/customer-portal/styles.css');
  assert.match(html, /id="resendVerification"/);
  assert.match(html, /id="copyConnectCode"/);
  assert.match(html, /resultados de mercado não são garantidos/i);
  assert.match(app, /\/v1\/customer\/resend-verification/);
  assert.match(app, /usedTotal/);
  assert.match(app, /totalLimit/);
  assert.match(app, /paymentsConfigured/);
  assert.match(app, /Pagamento aprovado\. Sincronizando seu acesso/);
  assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*\}/i);
  assert.match(html, /id="authModal"[^>]*hidden/);
  assert.match(html, /id="verifyView"[^>]*hidden/);
  assert.match(html, /id="accountView"[^>]*hidden/);
});

test('paid entitlement upgrade does not leave an old trial active', () => {
  const server = read('backend/src/server.js');
  assert.match(server, /function grantPaidEntitlement/);
  assert.match(server, /previousKey/);
  assert.match(server, /revokeLicenseByKey/);
  assert.match(server, /PAYMENTS_CONFIGURED\s*=\s*!!\(MP_ACCESS_TOKEN\s*&&\s*MP_WEBHOOK_SECRET\)/);
  assert.match(server, /pruneConnectCodes/);
  assert.match(server, /access_inactive/);
});

test('lifetime plan is a one-time commercial plan with unlimited entitlement', () => {
  const server = read('backend/src/server.js');
  const portal = read('apps/customer-portal/app.js');
  assert.match(server, /SALES_LIFETIME_PRICE/);
  assert.match(server, /LIFETIME_DAYS\s*=\s*36500/);
  assert.match(server, /id:\s*'lifetime'/);
  assert.match(server, /commercialPlan\s*=\s*'lifetime'/);
  assert.match(server, /billing:\s*'one_time'/);
  assert.match(portal, /COMPRAR VITALÍCIO/);
  assert.match(portal, /pagamento único/i);
  assert.match(portal, /sem vencimento/i);
});

test('preflight continuously protects candle and expiration alignment', () => {
  const preflight = read('src/sidepanel/preflight.js');
  assert.match(preflight, /enforceRuntimeAlignment/);
  assert.match(preflight, /SCANNER PAUSADO/);
  assert.match(preflight, /ATS_SET_SCANNER/);
  assert.match(preflight, /expiração .* é menor que a vela/);
  assert.match(preflight, /CasaTrade está com expiração/);
});

test('admin ops does not inject CRM twice and does not fake a successful sync', () => {
  const ops = read('apps/admin-dashboard/ops.js');
  assert.match(ops, /__ATS_OPS__/);
  assert.doesNotMatch(ops, /script\.src=['"]crm\.js/);
  assert.match(ops, /falha na atualização/);
  assert.match(ops, /const before=metrics/);
  assert.match(ops, /metrics!==before/);
  assert.match(ops, /\/v1\/public\/config/);
});

test('extension sync indicator is based on a confirmed heartbeat response', () => {
  const telemetry = read('src/services/telemetry.js');
  const panel = read('src/sidepanel/app.js');
  assert.match(telemetry, /lastSyncAttempt/);
  assert.match(telemetry, /lastSyncSuccess/);
  assert.match(telemetry, /lastSyncError/);
  assert.match(telemetry, /acceptedAt/);
  assert.match(panel, /lastSyncSuccess/);
  assert.match(panel, /atsTelemetryStatus/);
  assert.match(panel, /telemetryError\?'ERRO'/);
});

test('structured feed requires repeated recent network observations', () => {
  const probe = read('src/content/network-probe.js');
  const adapter = read('src/content/generic-adapter.js');
  assert.match(probe, /seenCount/);
  assert.match(probe, /transport/);
  assert.match(probe, /trimSet\(stats\.endpoints, 100\)/);
  assert.match(adapter, /seenCount \|\| 0\) >= 2/);
  assert.match(adapter, /allowedTransports/);
  assert.match(adapter, /Date\.now\(\) - Number\(c\.observedAt \|\| 0\) <= 6000/);
});

test('extension account refresh clears expired account tokens instead of showing stale connected state', () => {
  const account = read('src/sidepanel/account-login.js');
  assert.match(account, /clearAccountSession/);
  assert.match(account, /account_token_invalid/);
  assert.match(account, /Sessão da conta expirada/);
});

test('backend is consolidated into server.js without versioned child servers', () => {
  const server = read('backend/src/server.js');
  const rootPackage = JSON.parse(read('package.json'));
  const backendPackage = JSON.parse(read('backend/package.json'));
  assert.equal(rootPackage.scripts.start, 'node backend/src/server.js');
  assert.equal(backendPackage.scripts.start, 'node src/server.js');
  assert.doesNotMatch(server, /spawn\s*\(/);
  assert.equal(fs.existsSync(path.join(root, 'backend/src/server-v08.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'backend/src/server-v09.js')), false);
});
