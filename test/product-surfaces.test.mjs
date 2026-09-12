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

test('synchronized operation setup is native and blocks mismatched or paused state', () => {
  const html = read('src/sidepanel/index.html');
  const app = read('src/sidepanel/app.js');
  const sync = read('src/background-platform-sync.js');
  assert.equal(fs.existsSync(path.join(root, 'src/sidepanel/preflight.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'src/sidepanel/experience.js')), false);
  assert.match(html, /id="tradeAmount"/);
  assert.match(html, /VALOR NA PLATAFORMA/);
  assert.match(html, /VELA NA PLATAFORMA/);
  assert.match(html, /EXPIRAÇÃO NA PLATAFORMA/);
  assert.match(html, /id="pauseAllBtn"/);
  assert.match(app, /ATS_SYNC_PLATFORM_PREFERENCES/);
  assert.match(app, /CasaTrade sincronizada/);
  assert.match(app, /const canStart=online&&licensed&&configuredPrefs\(prefs\)&&aligned\(s\)&&!paused/);
  assert.match(app, /runtimePaused/);
  assert.match(sync, /patch\.scanner = 'idle'/);
  assert.match(sync, /Leitura pausada:/);
  assert.match(sync, /amountOk/);
  assert.match(sync, /timeframeOk/);
  assert.match(sync, /expirationOk/);
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

test('extension exposes actual feed latency and telemetry status without faking synchronization', () => {
  const telemetry = read('src/services/telemetry.js');
  const panel = read('src/sidepanel/app.js');
  const background = read('src/background.js');
  assert.match(telemetry, /lastSyncAttempt/);
  assert.match(telemetry, /lastSyncSuccess/);
  assert.match(telemetry, /lastSyncError/);
  assert.match(telemetry, /acceptedAt/);
  assert.match(panel, /atsTelemetryStatus/);
  assert.match(panel, /latency/);
  assert.match(panel, / ms/);
  assert.match(background, /latencyOf/);
  assert.match(background, /feedQuality/);
});

test('structured feed requires repeated recent network observations and active-asset matching', () => {
  const probe = read('src/content/network-probe.js');
  const adapter = read('src/content/generic-adapter.js');
  assert.match(probe, /seenCount/);
  assert.match(probe, /transport/);
  assert.match(probe, /recentCandles/);
  assert.match(probe, /feedQuality/);
  assert.match(adapter, /seenCount >= 2/);
  assert.match(adapter, /observedAt <= 6500|t - c\.observedAt <= 6500/);
  assert.match(adapter, /structuredNetworkQuote/);
  assert.match(adapter, /selectedAsset/);
  assert.match(adapter, /structuredQuotes: structured/);
});

test('weighted AI, risk, chart overlay and backtest are visible product surfaces', () => {
  const html = read('src/sidepanel/index.html');
  const scoring = read('src/core/ai-scoring.js');
  const risk = read('src/core/risk-controls.js');
  const overlay = read('src/content/chart-overlay.js');
  const backtest = read('src/core/backtest.js');
  assert.match(html, /NOTA IA/);
  assert.match(html, /PRICE ACTION/);
  assert.match(html, /CORRELAÇÃO/);
  assert.match(html, /CALENDÁRIO \/ NOTÍCIAS/);
  assert.match(html, /BACKTEST AUTOMATIZADO/);
  assert.match(scoring, /AI_WEIGHTS/);
  assert.match(risk, /RISK_PROFILES/);
  assert.match(overlay, /ats-chart-overlay/);
  assert.match(backtest, /runBacktest/);
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
