import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(url, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${url}`);
}

test('v0.8 secure telemetry flows from license activation to resolved live operation', { timeout: 20000 }, async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ats-v08-'));
  const publicPort = 18780;
  const internalPort = 18790;
  const base = `http://127.0.0.1:${publicPort}`;
  const adminKey = 'integration-admin-key';
  const apiKey = 'integration-api-key';
  const child = spawn(process.execPath, ['backend/src/server-v08.js'], {
    cwd: repoRoot, detached: true, stdio: 'ignore',
    env: { ...process.env, NODE_ENV: 'test', PORT: String(publicPort), ATS_INTERNAL_PORT: String(internalPort), ATS_DATA_DIR: dataDir, ATS_ADMIN_KEY: adminKey, ATS_API_KEY: apiKey, CORS_ORIGINS: '*' }
  });

  try {
    const health = await waitFor(`${base}/health`);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.version, '0.8.0');
    assert.equal(healthJson.gateway, 'secure-client-telemetry');

    const adminPage = await fetch(`${base}/admin/`);
    assert.equal(adminPage.status, 200);
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /\/admin\/live\.js\?v=0\.8\.0/);
    assert.match(adminHtml, /\/admin\/live\.css\?v=0\.8\.0/);
    assert.match(adminHtml, /\/admin\/crm\.js\?v=0\.8\.0/);

    const unauthorizedOps = await fetch(`${base}/v1/admin/operations`);
    assert.equal(unauthorizedOps.status, 401);

    const create = await fetch(`${base}/v1/admin/licenses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': adminKey },
      body: JSON.stringify({ customerName: 'Integration Client', plan: 'starter', days: 30 })
    });
    assert.equal(create.status, 201);
    const created = await create.json();
    assert.ok(created.license?.key);

    const installationId = 'integration-installation';
    const activate = await fetch(`${base}/v1/license/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseKey: created.license.key, installationId, version: '0.8.0' })
    });
    assert.equal(activate.status, 200);
    const activation = await activate.json();
    assert.equal(activation.ok, true);
    assert.ok(activation.clientToken);
    assert.equal(activation.license.devices, 1);

    const secondDevice = await fetch(`${base}/v1/license/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ licenseKey: created.license.key, installationId: 'second-installation', version: '0.8.0' })
    });
    assert.equal(secondDevice.status, 403);
    const blocked = await secondDevice.json();
    assert.equal(blocked.error, 'device_locked');

    const auth = { 'content-type': 'application/json', authorization: `Bearer ${activation.clientToken}` };
    const heartbeat = await fetch(`${base}/v1/client/heartbeat`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ platformId: 'casatrade', platformName: 'CasaTrade', connection: 'online', scanning: true, asset: 'EUR/USD', timeframe: 'S5', expiration: '5s', price: 1.1000, signalState: 'CONFIRM', direction: 'BUY', score: 84, confirmations: '6 / 7', feedQuality: 96, structured: true, version: '0.8.0' })
    });
    assert.equal(heartbeat.status, 200);

    const event = await fetch(`${base}/v1/client/events`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ type: 'signal_confirmed', data: { signalId: 'integration-signal-1', platformId: 'casatrade', platformName: 'CasaTrade', asset: 'EUR/USD', direction: 'BUY', entryPrice: 1.1000, score: 84, grade: 'A', timeframe: 'S5', expiration: '5s', durationMs: 5000, confirmations: '6 / 7', feedQuality: 96 } })
    });
    assert.equal(event.status, 201);

    await sleep(5200);
    const resolve = await fetch(`${base}/v1/client/heartbeat`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ platformId: 'casatrade', platformName: 'CasaTrade', connection: 'online', scanning: true, asset: 'EUR/USD', timeframe: 'S5', expiration: '5s', price: 1.1010, signalState: 'SEARCHING', score: 0, feedQuality: 96, structured: true, version: '0.8.0' })
    });
    assert.equal(resolve.status, 200);

    const ops = await fetch(`${base}/v1/admin/operations`, { headers: { 'x-admin-key': adminKey } });
    assert.equal(ops.status, 200);
    const live = await ops.json();
    assert.equal(live.summary.onlineClients, 1);
    assert.equal(live.summary.confirmedSignals, 1);
    assert.equal(live.summary.wins, 1);
    assert.equal(live.summary.losses, 0);
    assert.equal(live.summary.observedAccuracy, 100);
    assert.equal(live.signals[0].outcome, 'win');
    assert.equal(live.signals[0].resultSource, 'scanner_feed_after_expiry');
  } finally {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    await sleep(200);
    await rm(dataDir, { recursive: true, force: true });
  }
});
