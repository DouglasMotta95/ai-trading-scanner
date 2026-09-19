import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');

test('only authoritative license errors invalidate the cached license',()=>{
  const s=read('src/services/license.js');
  for(const e of ['license_not_found','license_inactive','license_expired','device_limit_reached']) assert.ok(s.includes(e),e);
  assert.match(s,/AUTHORITATIVE_LICENSE_ERRORS/);
  assert.doesNotMatch(s,/AUTHORITATIVE_LICENSE_ERRORS = new Set\([^)]*device_locked/s);
});

test('signal consumption remains separated from license validation state',()=>{
  const s=read('src/services/license.js');
  assert.match(s,/export async function consumeSignal/);
  assert.match(s,/\/v1\/license\/consume/);
  assert.doesNotMatch(s,/consumeSignal[\s\S]{0,1200}invalidateCachedLicense/);
});
