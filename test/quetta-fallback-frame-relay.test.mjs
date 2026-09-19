import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('fallback frame recovery remains packaged for Android/Quetta-style frame limitations',()=>{
  const m=JSON.parse(read('manifest.json'));
  const scripts=m.content_scripts.flatMap(r=>r.js||[]);
  assert.ok(scripts.includes('src/content/opaque-frame-recovery.js'));
  assert.ok(scripts.includes('src/content/opaque-frame-top-bridge.js'));
  assert.match(read('src/background-entry.js'),/background-opaque-frame-proxy\.js/);
});
