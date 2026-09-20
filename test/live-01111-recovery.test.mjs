import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('current build keeps canvas/network clock recovery probes packaged',()=>{
  const m=JSON.parse(read('manifest.json'));
  const scripts=m.content_scripts.flatMap(r=>r.js||[]);
  assert.equal(m.version,'0.11.49');
  assert.ok(scripts.includes('src/content/canvas-countdown-probe.js'));
  assert.ok(scripts.includes('src/content/market-cycle-clock-v4.js'));
});

test('UI observer still reads real account and expiration controls',()=>{
  const o=read('src/content/casatrade-ui-observer-v2.js');
  assert.match(o,/balanceCandidate/);
  assert.match(o,/payoutCandidate/);
  assert.match(o,/expirationCandidate/);
});

test('live expiration never substitutes for candle-close countdown authority',()=>{
  const c=read('src/content/market-cycle-clock-v4.js');
  assert.match(c,/candle-close/);
  assert.match(c,/expirySemantic/);
});
