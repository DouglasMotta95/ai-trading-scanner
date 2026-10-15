import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('manifest, packages and API source share the actual extension version', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const rootPackage = JSON.parse(read('package.json'));
  const backendPackage = JSON.parse(read('backend/package.json'));
  const server = read('backend/src/server.js');
  assert.equal(manifest.version, '0.12.16');
  assert.equal(rootPackage.version, manifest.version);
  assert.equal(backendPackage.version, manifest.version);
  assert.equal(manifest.version_name, '0.12.16-same-host-frame-clock-binding');
  assert.match(server, /EXTENSION_MANIFEST\.version/);
  assert.doesNotMatch(server, /EXTENSION_LATEST_VERSION \|\|/);
});

test('portal has accessible mobile navigation and does not pretend its demo is live', () => {
  const html = read('apps/customer-portal/index.html');
  const css = read('apps/customer-portal/styles.css');
  const js = read('apps/customer-portal/app.js');
  assert.match(html, /id="mobileNavToggle"[^>]*aria-expanded="false"[^>]*aria-controls="siteNav"/);
  assert.match(html, /id="siteNav" aria-label="Navegação principal"/);
  assert.match(html, /Nenhum sinal ao vivo é representado/);
  assert.doesNotMatch(html, /POSSÍVEL COMPRA → ENTRAR/);
  assert.match(js, /siteNav\.classList\.toggle\('mobile-open'\)/);
  assert.match(css, /\.site-header nav#siteNav\.mobile-open\{display:flex\}/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('live local API config and download use manifest version despite stale env value', async t => {
  const manifest = JSON.parse(read('manifest.json'));
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-release-check-'));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['backend/src/server.js'], {
    cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port),
      ATS_DATA_DIR: dataDir, PUBLIC_BASE_URL: base, APP_VERSION: '',
      EXTENSION_LATEST_VERSION: '0.11.47' }
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1500))]);
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    try { const r = await fetch(base + '/health'); ready = r.ok; } catch {}
    if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, 'API did not start: ' + stderr);

  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.version, manifest.version);
  assert.equal(health.extensionLatestVersion, manifest.version);
  const publicConfig = await (await fetch(base + '/v1/public/config')).json();
  assert.equal(publicConfig.extensionLatestVersion, manifest.version);
  const response = await fetch(base + '/download/extension');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') || '', new RegExp('ai-trading-scanner-v' + manifest.version + '\\.zip'));
  const archive = path.join(dataDir, 'extension.zip');
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const unzipped = spawnSync('unzip', ['-p', archive, 'manifest.json'], { encoding: 'utf8' });
  assert.equal(unzipped.status, 0, unzipped.stderr);
  assert.equal(JSON.parse(unzipped.stdout).version, manifest.version);
});
