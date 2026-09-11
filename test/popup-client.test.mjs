import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('extension action opens dedicated popup instead of the heavy scanner page',()=>{
  const manifest=JSON.parse(read('manifest.json'));
  assert.equal(manifest.action?.default_popup,'src/popup/index.html');
  assert.ok(manifest.host_permissions.includes('https://ats-control-center-v07-production.up.railway.app/*'));
});

test('first-use popup always exposes a manual license field and account code option',()=>{
  const html=read('src/popup/index.html');
  const js=read('src/popup/popup.js');
  for(const id of ['licenseKey','activateBtn','accountCode','connectAccountBtn','openPortalBtn']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/ATS_ACTIVATE_LICENSE/);
  assert.match(js,/\/v1\/license\/activate/);
  assert.match(js,/\/v1\/customer\/extension\/exchange/);
  assert.match(js,/atsLicenseKey/);
  assert.match(js,/atsInstallationId/);
});

test('activated customer popup exposes scanner, renewal, support and revalidation actions',()=>{
  const html=read('src/popup/index.html');
  const js=read('src/popup/popup.js');
  for(const id of ['openScannerBtn','renewBtn','changeKeyBtn','validateBtn','supportBtn','planName','expiry','usage','device']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/chrome\.sidePanel\?\.open/);
  assert.match(js,/chrome\.runtime\.getURL\('src\/sidepanel\/index\.html'\)/);
  assert.match(js,/PEDIR RENOVAÇÃO/);
});
