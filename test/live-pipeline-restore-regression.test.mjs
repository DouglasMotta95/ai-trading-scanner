import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('runtime keeps market session, central analyzer and control wired',()=>{
  const e=read('src/background-entry.js');
  assert.match(e,/background-market-session\.js/);
  assert.match(e,/background\.js/);
  assert.match(e,/background-control\.js/);
});

test('manifest identifies the current live-asset recovery build',()=>{
  const m=JSON.parse(read('manifest.json'));
  assert.equal(m.version,'0.11.49');
  assert.match(m.version_name,/live-entry-asset-switch-hotfix/);
});
