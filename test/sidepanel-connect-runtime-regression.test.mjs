import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { detectPlatform } from '../src/platforms/registry.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('sidepanel connect runtime is isolated and wired to the active CasaTrade tab', () => {
  const html = read('src/sidepanel/index.html');
  const shell = read('src/sidepanel/ui-shell-v2.js');

  assert.match(html, /id="connectScanner"/);
  assert.ok(html.indexOf('app-v2.js') < html.indexOf('ui-shell-v2.js'));
  assert.match(shell, /^\s*\(\(\) => \{/);
  assert.match(shell, /ATS_CONNECT_ACTIVE_TAB/);
  assert.match(shell, /connectScanner.*addEventListener\('click'/s);
  assert.doesNotMatch(shell, /manual-trade-ui\.js/);
});

test('classic sidepanel helpers do not redeclare app-v2 globals', () => {
  for (const path of [
    'src/sidepanel/radar-ui.js',
    'src/sidepanel/validation-ui.js',
    'src/sidepanel/manual-trade-ui.js'
  ]) {
    assert.match(read(path), /^\s*\(\(\) => \{/);
  }
});

test('all CasaTrade host families allowed by the manifest are recognized by the registry', () => {
  for (const host of [
    'trade.casatrade.com',
    'app.casatrade.io',
    'casatraders.online',
    'trade.casatraders.online',
    'ivcasatraders.online',
    'app.ivcasatraders.online'
  ]) {
    assert.equal(detectPlatform(host)?.id, 'casatrade', host);
  }
});
