import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/background-fast-decision.js', import.meta.url), 'utf8');

test('fast decision uses the current CasaTrade market clock instead of a stale signal countdown', () => {
  assert.match(source, /secondsRemaining:\s*observed\.diagnostics\?\.marketClock\?\.secondsRemaining\s*\?\?\s*observed\.signal\?\.secondsRemaining/);
});
