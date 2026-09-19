import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current build wires live recovery, exact clock and expiration observation',()=>{
  const e=read('src/background-entry.js');
  const m=JSON.parse(read('manifest.json'));
  assert.equal(m.version,'0.11.48');
  assert.match(e,/background-modern-injector\.js/);
  assert.match(e,/background-control\.js/);
  assert.match(e,/background-platform-controls\.js/);
  assert.ok(m.content_scripts.flatMap(r=>r.js||[]).includes('src/content/market-cycle-clock-v4.js'));
  assert.ok(m.content_scripts.flatMap(r=>r.js||[]).includes('src/content/casatrade-expiration-probe.js'));
});
