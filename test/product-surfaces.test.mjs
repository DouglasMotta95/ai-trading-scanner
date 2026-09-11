import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('public portal exposes verification recovery, code copy, extension onboarding and risk disclosure', () => {
  const html = read('apps/customer-portal/index.html');
  const app = read('apps/customer-portal/app.js');
  const css = read('apps/customer-portal/styles.css');
  assert.match(html, /id="resendVerification"/);
  assert.match(html, /id="copyConnectCode"/);
  assert.match(html, /id="extensionDownload"/);
  assert.match(html, /ai-trading-scanner\/archive\/refs\/heads\/main\.zip/);
  assert.match(html, /01[\s\S]*Baixe a extensão/);
  assert.match(html, /02[\s\S]*Instale no Chrome ou Edge/);
  assert.match(html, /03[\s\S]*Conecte sua conta/);
  assert.match(html, /resultados de mercado não são garantidos/i);
  assert.match(app, /\/v1\/customer\/resend-verification/);
  assert.match(app, /usedTotal/);
  assert.match(app, /totalLimit/);
  assert.match(app, /paymentsConfigured/);
  assert.match(app, /Retorno do checkout recebido\. Confirmando pagamento com o servidor/);
  assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*\}/i);
  assert.match(html, /id="authModal"[^>]*hidden/);
  assert.match(html, /id="verifyView"[^>]*hidden/);
  assert.match(html, /id="accountView"[^>]*hidden/);
});

test('customer portal security sanitizes auth fields, rate-limits customer routes and never accepts card data', () => {
  const app = read('apps/customer-portal/app.js');
  const server = read('backend/src/server.js');
  assert.match(app, /cleanTextInput/);
  assert.match(app, /cleanEmailInput/);
  assert.match(app, /authPayload/);
  assert.match(server, /cleanPlain/);
  assert.match(server, /validEmail/);
  assert.match(server, /htmlEscape/);
  assert.match(server, /pathname\.startsWith\('\/v1\/customer\/'\)/);
  assert.match(server, /only\(b, \['plan'\]\)/);
  assert.match(app, /JSON\.stringify\(\{plan:String\(plan\|\|''\)\}\)/);
  assert.doesNotMatch(app, /card_number|security_code|cvv|cardholder/i);
  assert.doesNotMatch(server, /card_number|security_code|cvv|cardholder/i);
});

test('payment success URL is not authoritative and entitlement requires verified Mercado Pago data', () => {
  const app = read('apps/customer-portal/app.js');
  const server = read('backend/src/server.js');
  assert.match(app, /Ainda não há confirmação do pagamento no servidor/);
  assert.match(server, /mpSignatureValid/);
  assert.match(server, /invalid_signature/);
  assert.match(server, /api\.mercadopago\.com\/v1\/payments/);
  assert.match(server, /payment\.status === 'approved'/);
  assert.match(server, /amountOk/);
  assert.match(server, /currencyOk/);
  assert.match(server, /preferenceOk/);
  assert.match(server, /metadataAccountOk/);
  assert.match(server, /metadataPlanOk/);
  assert.match(server, /rejected_mismatch/);
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

test('admin ops documents its global override debt without loading CRM', () => {
  const ops = read('apps/admin-dashboard/ops.js');
  assert.match(ops, /TECH DEBT/);
  assert.match(ops, /__ATS_OPS__/);
  assert.doesNotMatch(ops, /script\.src=['"]crm\.js/);
  assert.match(ops, /falha na atualização/);
  assert.match(ops, /const before=metrics/);
  assert.match(ops, /metrics!==before/);
  assert.match(ops, /\/v1\/public\/config/);
});

test('live operations is integrated natively and obsolete CRM/live scripts are removed', () => {
  const html = read('apps/admin-dashboard/index.html');
  const app = read('apps/admin-dashboard/app.js');
  const server = read('backend/src/server.js');
  assert.match(html, /data-page="operations"/);
  assert.match(html, /data-view="operations"/);
  assert.match(html, /live\.css/);
  assert.match(app, /\/v1\/admin\/operations/);
  assert.match(app, /function renderOperations/);
  assert.match(app, /observedAccuracy/);
  assert.match(app, /structured/);
  assert.equal(fs.existsSync(path.join(root, 'apps/admin-dashboard/crm.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'apps/admin-dashboard/live.js')), false);
  assert.doesNotMatch(server, /crm\.js/);
  assert.doesNotMatch(server, /live\.js/);
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
