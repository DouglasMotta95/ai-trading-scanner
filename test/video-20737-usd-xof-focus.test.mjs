import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('all focused-asset readers recognize USD/XOF OTC without guessing another tab', () => {
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

test('alias bridge parser also recognizes XOF/XAF rather than dropping the selected market', () => {
  const source = read('src/content/focused-asset-alias-bridge.js');
  const start = source.indexOf('const ALIASES = new Map(');
  const end = source.indexOf('\n  const metaText', start);
  assert.ok(start >= 0 && end > start, 'alias parser block exists');
  const parserBlock = source.slice(start, end);
  const parser = vm.runInNewContext(`(() => {
    ${parserBlock}
    return { directPairFromText, canonicalFromText };
  })()`);
  assert.equal(parser.directPairFromText('USD/XOF (OTC)'), 'USD/XOF (OTC)');
  assert.equal(parser.canonicalFromText('USD/XOF (OTC)'), 'USD/XOF (OTC)');
  assert.equal(parser.canonicalFromText('USD/XAF (OTC)'), 'USD/XAF (OTC)');
  assert.equal(parser.canonicalFromText('EUR/USD (OTC)'), 'EUR/USD (OTC)');
});

test('protocol focus path and compact market normalization also accept XOF/XAF', () => {
  const protocolSource = read('src/content/focused-asset-protocol.js');
  const protocolStart = protocolSource.indexOf('const quotes = new Set(');
  const protocolEnd = protocolSource.indexOf('\n\n  function visualBlocksProtocolRollback', protocolStart);
  assert.ok(protocolStart >= 0 && protocolEnd > protocolStart, 'protocol normalizer block exists');
  const protocol = vm.runInNewContext(`(() => {
    const host = 'trade.casatrade.com';
    ${protocolSource.slice(protocolStart, protocolEnd)}
    return normAsset;
  })()`);
  assert.equal(protocol('USD/XOF (OTC)'), 'USD/XOF (OTC)');
  assert.equal(protocol('USDXOF OTC'), 'USD/XOF (OTC)');
  assert.equal(protocol('USD/XAF (OTC)'), 'USD/XAF (OTC)');

  const marketSource = read('src/background-market-session.js');
  const marketStart = marketSource.indexOf('function normAsset(');
  const marketEnd = marketSource.indexOf('\nconst marketId', marketStart);
  assert.ok(marketStart >= 0 && marketEnd > marketStart, 'market session normalizer exists');
  const marketNorm = vm.runInNewContext(`(() => {
    const clean = value => String(value ?? '').normalize('NFKC').replace(/\\s+/g, ' ').trim();
    ${marketSource.slice(marketStart, marketEnd)}
    return normAsset;
  })()`);
  assert.equal(marketNorm('USDXOF OTC'), 'USD/XOF (OTC)');
  assert.equal(marketNorm('USDXAF OTC'), 'USD/XAF (OTC)');
});

test('market focus stays explicit/ambiguous-safe after adding exotic currency quotes', () => {
  const source = read('src/content/focused-asset-v2.js');
  assert.match(source, /if \(!first\.interaction && !first\.explicit\) return null/);
  assert.match(source, /visualAuthority: Number\(winner\.ambiguityCount \|\| 0\) === 0 \|\| winner\.interaction === true \|\| winner\.explicit === true/);
});
