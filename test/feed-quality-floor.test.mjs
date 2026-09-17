import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../src/background.js',import.meta.url),'utf8');
test('Phase C requires feed quality of at least 80 for CONFIRM',()=>{ assert.match(source,/confirmationFeedQuality < 80/); assert.match(source,/minimum: 80/); });
