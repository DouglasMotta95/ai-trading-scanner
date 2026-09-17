from pathlib import Path

p = Path('src/core/orchestrator.js')
text = p.read_text()
old = "const rangeBlocked = regime?.type === 'range';"
new = "const extremeVolatilityBlocked = regime?.extremeVolatility === true;"
if old not in text:
    raise SystemExit('range gate anchor not found')
text = text.replace(old, new, 1)
text = text.replace('if (rangeBlocked) {', 'if (extremeVolatilityBlocked) {')
text = text.replace('const canConfirm = !rangeBlocked && observeConfirmation', 'const canConfirm = !extremeVolatilityBlocked && observeConfirmation')
text = text.replace("const noTradeReason = rangeBlocked\n      ? 'AGUARDANDO — mercado sem tendência definida.'", "const noTradeReason = extremeVolatilityBlocked\n      ? 'AGUARDANDO — volatilidade extrema; confirmação bloqueada.'")
text = text.replace('if (rangeBlocked) {', 'if (extremeVolatilityBlocked) {')
if 'rangeBlocked' in text:
    raise SystemExit('stale rangeBlocked reference remains')
p.write_text(text)

t = Path('test/market-regime-gate.test.mjs')
src = t.read_text()
start = src.index("test('range regime blocks ENTER even after confirmation score and stability are otherwise sufficient'")
end = src.index("\ntest('regime gate is additive", start)
new_test = """test('normal range does not block a strong local next-candle confirmation', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_110_000_000 / minute) * minute;
  const candles = rangeWithStrongCurrent(bucket);

  processSnapshot(snapshot(bucket, 35_000, candles), { connection: 'online' });
  processSnapshot(snapshot(bucket, 36_000, candles), { connection: 'online' });
  const firstFinal = processSnapshot(snapshot(bucket, 51_000, candles), { connection: 'online' });
  const confirmed = processSnapshot(snapshot(bucket, 52_000, candles), { connection: 'online' });

  assert.equal(confirmed.signal.regime?.type, 'range');
  assert.equal(confirmed.signal.regime?.extremeVolatility, false);
  assert.ok(Number(confirmed.signal.analysisScore) >= 58, `expected score >= 58, got ${confirmed.signal.analysisScore}`);
  assert.notEqual(firstFinal.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.state, 'CONFIRM');
  assert.equal(confirmed.signal.uiState, 'ENTER_BUY');
  assert.equal(confirmed.signal.direction, 'BUY');
});
"""
t.write_text(src[:start] + new_test + src[end:])

m = Path('manifest.json')
manifest = m.read_text()
if '"version": "0.10.2"' not in manifest:
    raise SystemExit('manifest version anchor not found')
m.write_text(manifest.replace('"version": "0.10.2"', '"version": "0.10.3"', 1))
