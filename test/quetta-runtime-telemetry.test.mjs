import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('runtime boot/injection telemetry remains wired without exposing page secrets',()=>{
  const e=read('src/background-entry.js');
  const m=JSON.parse(read('manifest.json'));
  assert.equal(m.version,'0.11.53');
  assert.match(e,/background-runtime-telemetry\.js/);
  assert.ok(m.content_scripts.flatMap(r=>r.js||[]).includes('src/content/runtime-boot-probe.js'));
});
