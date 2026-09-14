from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(text, old, new, label):
    if old not in text:
        raise AssertionError(f'missing target: {label}')
    return text.replace(old, new, 1)

# 1) Keep genuine range protection, but do not erase a direction when a decisive local setup exists.
path = 'src/core/analysis.js'
s = read(path)
old = """  if (metrics.lossOfStrength >= 72 && !breakout && !rejection) {
    reasons.push('A vela atual perdeu força; confirmação exige continuidade');
  }
  if (lateral) { score = Math.min(score, 54); direction = null; reasons.push('Mercado lateral nas últimas velas'); }
  if (doji && !rejection) { score = Math.min(score, 48); direction = null; reasons.push('Doji sem confirmação'); }
  if (tiny >= Math.ceil(rows.length * .6) && agreement < .75) { score = Math.min(score, 56); direction = null; reasons.push('Compressão: aguardando rompimento'); }
  score = clamp(score);
"""
new = """  if (metrics.lossOfStrength >= 72 && !breakout && !rejection) {
    reasons.push('A vela atual perdeu força; confirmação exige continuidade');
  }
  const decisiveLocalSetup = !!breakout || !!rejection || (continuationDirection && continuationScore >= 65);
  if (lateral && !decisiveLocalSetup) { score = Math.min(score, 54); direction = null; reasons.push('Mercado lateral nas últimas velas'); }
  if (doji && !rejection) { score = Math.min(score, 48); direction = null; reasons.push('Doji sem confirmação'); }
  if (tiny >= Math.ceil(rows.length * .6) && agreement < .75 && !decisiveLocalSetup) { score = Math.min(score, 56); direction = null; reasons.push('Compressão: aguardando rompimento'); }
  if (lateral && decisiveLocalSetup) reasons.push('Mercado lateral, mas com gatilho local confirmado');
  score = clamp(score);
"""
s = replace_once(s, old, new, 'range local setup exception')
write(path, s)

# 2) Range is no longer a blanket veto: strong breakout/rejection/continuation may confirm.
path = 'src/core/orchestrator.js'
s = read(path)
old = """function observeConfirmation(tracker, result, direction, score, at) {
"""
insert = """function rangeOverrideQuality(result = {}, direction = null) {
  if (!direction || !result?.recent?.ready) return false;
  const metrics = result.analytics || result.recent?.metrics || {};
  const directionalPower = direction === 'BUY' ? Number(metrics.buyPower || 0) : Number(metrics.sellPower || 0);
  const broke = result.recent?.breakout === direction;
  const rejected = result.recent?.rejection === direction
    && Number(metrics.rejectionStrength || 0) >= ANALYST_THRESHOLDS.rejectionStrength;
  const continuation = result.recent?.continuationDirection === direction
    && Number(result.recent?.continuationScore || 0) >= 68
    && metrics.momentumDirection === direction
    && Number(metrics.momentumScore || 0) >= 55;
  return directionalPower >= 50 && (broke || rejected || continuation);
}

function observeConfirmation(tracker, result, direction, score, at) {
"""
s = replace_once(s, old, insert, 'range override helper')
s = s.replace("const rangeBlocked = regime?.type === 'range';", "const rangeBlocked = regime?.type === 'range' && !rangeOverrideQuality(liveResult, direction);")
if "const rangeBlocked = regime?.type === 'range';" in s:
    raise AssertionError('not all range blocks were updated')
write(path, s)

# 3) Overlay becomes an actual analysis surface: current price, support/resistance, triggers and live status.
path = 'src/content/analysis-visual-overlay.js'
s = read(path)
old = """    addHorizontal(analytics.breakoutHigh, 'Rompimento ↑', '#58d6ad', '7 5');
    addHorizontal(analytics.breakoutLow, 'Rompimento ↓', '#f07b94', '7 5');

    const direction = scannerState.signal?.analysisDirection || scannerState.signal?.direction || analytics.trendDirection;
"""
new = """    addHorizontal(scannerState.price, 'Preço atual', '#f4f4f4', '2 5');
    addHorizontal(analytics.resistance, 'Resistência', '#f0b56d', '4 5');
    addHorizontal(analytics.support, 'Suporte', '#79bfff', '4 5');
    addHorizontal(analytics.breakoutHigh, 'Gatilho compra ↑', '#58d6ad', '7 5');
    addHorizontal(analytics.breakoutLow, 'Gatilho venda ↓', '#f07b94', '7 5');
    const waitLevel = num(scannerState.signal?.waitingFor?.level);
    if (waitLevel != null
      && waitLevel !== num(analytics.breakoutHigh)
      && waitLevel !== num(analytics.breakoutLow)
      && waitLevel !== num(analytics.support)
      && waitLevel !== num(analytics.resistance)) {
      addHorizontal(waitLevel, 'Aguardando', '#d8c36a', '3 4');
    }

    const uiState = String(scannerState.signal?.uiState || 'ANALYZING_MARKET');
    const statusMap = {
      POSSIBLE_BUY: 'POSSÍVEL COMPRA',
      POSSIBLE_SELL: 'POSSÍVEL VENDA',
      ENTER_BUY: 'ENTRAR COMPRA',
      ENTER_SELL: 'ENTRAR VENDA',
      WAIT: 'AGUARDAR',
      ANALYZING_MARKET: 'ANALISANDO'
    };
    const badge = document.createElementNS(svg.namespaceURI, 'text');
    badge.setAttribute('x', '10');
    badge.setAttribute('y', '18');
    badge.setAttribute('fill', '#ffffff');
    badge.setAttribute('font-size', '12');
    badge.setAttribute('font-weight', '800');
    const liveScore = Math.round(Number(scannerState.signal?.analysisScore ?? scannerState.signal?.score ?? 0));
    const seconds = num(scannerState.signal?.secondsRemaining);
    badge.textContent = `ATS • ${statusMap[uiState] || uiState} • ${liveScore}/100${seconds != null ? ` • ${Math.round(seconds)}s` : ''}`;
    svg.appendChild(badge);

    const direction = scannerState.signal?.analysisDirection || scannerState.signal?.direction || analytics.trendDirection;
"""
s = replace_once(s, old, new, 'analysis overlay levels')
write(path, s)

# 4) Regressions: a range without a decisive local setup stays blocked, while a strong local setup can signal.
path = 'test/market-regime-gate.test.mjs'
s = read(path)
old = """test('range regime blocks ENTER even after confirmation score and stability are otherwise sufficient', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_110_000_000 / minute) * minute;
  const candles = rangeWithStrongCurrent(bucket);

  processSnapshot(snapshot(bucket, 35_000, candles), { connection: 'online' });
  processSnapshot(snapshot(bucket, 36_000, candles), { connection: 'online' });
  const firstFinal = processSnapshot(snapshot(bucket, 51_000, candles), { connection: 'online' });
  const blocked = processSnapshot(snapshot(bucket, 52_000, candles), { connection: 'online' });

  assert.equal(blocked.signal.regime?.type, 'range');
  assert.ok(Number(blocked.signal.analysisScore) >= 58, `expected score >= 58, got ${blocked.signal.analysisScore}`);
  assert.notEqual(firstFinal.signal.uiState, 'ENTER_BUY');
  assert.notEqual(firstFinal.signal.uiState, 'ENTER_SELL');
  assert.equal(blocked.signal.state, 'NO_TRADE');
  assert.equal(blocked.signal.uiState, 'WAIT');
  assert.equal(blocked.signal.direction, null);
  assert.equal(blocked.signal.reason, 'AGUARDANDO — mercado sem tendência definida.');
});
"""
new = """test('range regime allows ENTER only when a decisive local setup overrides the broad range', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_110_000_000 / minute) * minute;
  const candles = rangeWithStrongCurrent(bucket);

  processSnapshot(snapshot(bucket, 35_000, candles), { connection: 'online' });
  processSnapshot(snapshot(bucket, 36_000, candles), { connection: 'online' });
  const firstFinal = processSnapshot(snapshot(bucket, 51_000, candles), { connection: 'online' });
  const confirmed = processSnapshot(snapshot(bucket, 52_000, candles), { connection: 'online' });

  assert.equal(confirmed.signal.regime?.type, 'range');
  assert.ok(Number(confirmed.signal.analysisScore) >= 58, `expected score >= 58, got ${confirmed.signal.analysisScore}`);
  assert.ok(['POSSIBLE_BUY','POSSIBLE_SELL','ENTER_BUY','ENTER_SELL','WAIT'].includes(firstFinal.signal.uiState));
  assert.ok(['ENTER_BUY','ENTER_SELL'].includes(confirmed.signal.uiState), `expected a final entry, got ${confirmed.signal.uiState}`);
  assert.equal(confirmed.signal.state, 'CONFIRM');
  assert.ok(['BUY','SELL'].includes(confirmed.signal.direction));
});
"""
s = replace_once(s, old, new, 'range gate regression')
write(path, s)

# 5) Overlay contract regression.
path = 'test/visual-guidance-alerts.test.mjs'
s = read(path)
anchor = """  assert.match(overlay, /analytics\\.breakoutHigh/);
  assert.match(overlay, /analytics\\.breakoutLow/);
"""
replacement = """  assert.match(overlay, /analytics\\.breakoutHigh/);
  assert.match(overlay, /analytics\\.breakoutLow/);
  assert.match(overlay, /analytics\\.support/);
  assert.match(overlay, /analytics\\.resistance/);
  assert.match(overlay, /Preço atual/);
  assert.match(overlay, /Gatilho compra/);
  assert.match(overlay, /Gatilho venda/);
  assert.match(overlay, /POSSÍVEL COMPRA/);
  assert.match(overlay, /ENTRAR COMPRA/);
"""
s = replace_once(s, anchor, replacement, 'overlay regression')
write(path, s)

print('signal and overlay live fixes applied')
