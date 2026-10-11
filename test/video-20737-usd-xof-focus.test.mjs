import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('focused asset parser recognizes USD/XOF OTC without guessing EUR/USD', () => {
  const source = read('src/content/focused-asset-v2.js');
  const start = source.indexOf('const QUOTES = new Set(');
  const end = source.indexOf('\n  const canonicalAsset', start);
  assert.ok(start >= 0 && end > start, 'asset parser block exists');

  const parserBlock = source.slice(start, end);
  const assetsIn = vm.runInNewContext(`(() => {
    const clean = value => String(value ?? '').normalize('NFKC').replace(/\\s+/g, ' ').trim();
    ${parserBlock}
    return assetsIn;
  })()`);

  assert.equal(assetsIn('USD/XOF (OTC)')[0], 'USD/XOF (OTC)');
  assert.equal(assetsIn('EUR/USD (OTC)')[0], 'EUR/USD (OTC)');
  assert.equal(assetsIn('USD/XAF (OTC)')[0], 'USD/XAF (OTC)');
});

test('market focus stays explicit/ambiguous-safe after adding exotic currency quotes', () => {
  const source = read('src/content/focused-asset-v2.js');
  assert.match(source, /if \(!first\.interaction && !first\.explicit\) return null/);
  assert.match(source, /visualAuthority: Number\(winner\.ambiguityCount \|\| 0\) === 0 \|\| winner\.interaction === true \|\| winner\.explicit === true/);
});
