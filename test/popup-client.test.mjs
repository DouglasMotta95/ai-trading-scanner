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

test('first-use popup is visible immediately and exposes manual license plus account code',()=>{
  const html=read('src/popup/index.html');
  const js=read('src/popup/popup.js');
  assert.match(html,/id="activationView" class="card">/);
  assert.doesNotMatch(html,/id="loadingView"/);
  for(const id of ['licenseKey','activateBtn','accountCode','connectAccountBtn','openPortalBtn']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/ATS_ACTIVATE_LICENSE/);
  assert.match(js,/\/v1\/license\/activate/);
  assert.match(js,/\/v1\/customer\/extension\/exchange/);
  assert.match(js,/atsLicenseKey/);
  assert.match(js,/atsInstallationId/);
  assert.match(js,/atsLicenseSnapshot/);
});

test('first successful activation shows a five-step tutorial that remains available later',()=>{
  const html=read('src/popup/index.html');
  const js=read('src/popup/popup.js');
  for(const id of ['tutorialView','tutorialProgress','tutorialTitle','tutorialText','tutorialNext','tutorialSkip','tutorialBtn']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/const tutorialSteps=\[/);
  assert.match(js,/21 candles/);
  assert.match(js,/valor, vela e expiração/i);
  assert.match(js,/showTutorial\(state\)/);
  assert.match(js,/atsPopupOnboardingV1/);
});

test('activated customer popup exposes scanner, renewal, support and revalidation actions',()=>{
  const html=read('src/popup/index.html');
  const js=read('src/popup/popup.js');
  for(const id of ['openScannerBtn','renewBtn','changeKeyBtn','validateBtn','supportBtn','planName','expiry','usage','device']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(js,/chrome\.runtime\.getURL\('src\/sidepanel\/index\.html'\)/);
  assert.match(js,/chrome\.tabs\.create\(\{url,active:true\}\)/);
  assert.doesNotMatch(js,/chrome\.sidePanel\?\.open/);
  assert.match(html,/PEDIR RENOVAÇÃO/);
});

test('popup uses cached active access immediately and refreshes in background',()=>{
  const js=read('src/popup/popup.js');
  assert.match(js,/activeLicense\(state\.license\)/);
  assert.match(js,/setTimeout\(refreshAccessSilently,150\)/);
  assert.match(js,/Promise\.race/);
  assert.match(js,/validation_timeout/);
});

test('service worker disables persisted side-panel-on-icon behavior',()=>{
  const entry=read('src/background-entry.js');
  const compat=read('src/background-popup-compat.js');
  assert.match(entry,/background-popup-compat\.js/);
  assert.match(compat,/openPanelOnActionClick:false/);
  assert.match(compat,/onInstalled/);
  assert.match(compat,/onStartup/);
});
