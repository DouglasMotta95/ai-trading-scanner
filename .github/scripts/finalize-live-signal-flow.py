from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(text, old, new, label):
    if old not in text:
        raise AssertionError(f'missing target: {label}')
    return text.replace(old, new, 1)

# 1) Signal responsiveness: preserve approved score thresholds, but tolerate mobile throttling
# and expose a stable pre-signal as soon as it exists instead of hiding it until the last 30s.
path = 'src/core/orchestrator.js'
s = read(path)
s = replace_once(s, "const CANDIDATE_MAX_GAP_MS = 3500;", "const CANDIDATE_MAX_GAP_MS = 8000;", 'mobile stability gap')

old = """  const continuation = result.recent?.continuationDirection === direction
    && Number(result.recent?.continuationScore || 0) >= 60;
  return directionalPower >= 50 && (candleStrong || rejected || broke || continuation);
"""
new = """  const continuation = result.recent?.continuationDirection === direction
    && Number(result.recent?.continuationScore || 0) >= 60;
  const trendAligned = Number(result.recent?.agreement || 0) >= .7
    && metrics.momentumDirection === direction
    && Number(metrics.momentumScore || 0) >= 45;
  return directionalPower >= 50 && (candleStrong || rejected || broke || continuation || trendAligned);
"""
s = replace_once(s, old, new, 'trend-aligned confirmation quality')

marker = """  const buildingPattern = !!direction && score >= 30;
  return {
"""
insert = """  if (possibleDirection) {
    return {
      candles: closed,
      currentCandle: current,
      lastConfirmed,
      signal: baseSignal({
        ...common,
        state: 'WATCH',
        direction: possibleDirection,
        provisional: true,
        phase: 'POSSIBLE',
        uiState: possibleDirection === 'BUY' ? 'POSSIBLE_BUY' : 'POSSIBLE_SELL',
        reason: reasonFor(liveResult, possibleDirection, false),
        score: Math.max(score, Number(tracker.publishedScore || 0)),
        stability: stabilitySnapshot(tracker)
      })
    };
  }

""" + marker
s = replace_once(s, marker, insert, 'early possible signal')
write(path, s)

# 2) Range gate stays, but distinguish slow consistent trend from real sideways chop.
write('src/core/market-regime.js', """const finite = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function marketRegime(candles = []) {
  const recent = (Array.isArray(candles) ? candles : [])
    .map(candle => ({ high: finite(candle?.high), low: finite(candle?.low), close: finite(candle?.close) }))
    .filter(candle => candle.high != null && candle.low != null && candle.close != null)
    .slice(-20);

  if (recent.length < 20) return { type: 'unknown', volatility: 0, directional: 0, efficiency: 0, consistency: 0 };

  const ranges = recent.map(candle => Math.abs(candle.high - candle.low));
  const volatility = ranges.reduce((sum, value) => sum + value, 0) / Math.max(1, ranges.length);
  const closes = recent.map(candle => candle.close);
  const deltas = closes.slice(1).map((close, index) => close - closes[index]);
  const net = closes.at(-1) - closes[0];
  const move = Math.abs(net);
  const closePath = deltas.reduce((sum, delta) => sum + Math.abs(delta), 0);
  const efficiency = closePath > 0 ? Math.min(1, move / closePath) : 0;
  const upSteps = deltas.filter(delta => delta > 0).length;
  const downSteps = deltas.filter(delta => delta < 0).length;
  const consistency = deltas.length ? Math.max(upSteps, downSteps) / deltas.length : 0;
  const directional = volatility > 0 ? move / (volatility * recent.length) : 0;

  const directionalTrend = directional >= .28 && consistency >= .63;
  const efficientTrend = efficiency >= .48 && consistency >= .58;
  const trending = move > 0 && (directionalTrend || efficientTrend);

  return {
    type: trending ? (net > 0 ? 'uptrend' : 'downtrend') : 'range',
    volatility,
    directional,
    efficiency,
    consistency
  };
}

export function qualityGate({ connected, stale, regime, newsBlocked = false, dataQuality = 1 } = {}) {
  const reasons = [];
  if (!connected) reasons.push('Sem conexão');
  if (stale) reasons.push('Feed desatualizado');
  if (newsBlocked) reasons.push('Evento de alto impacto');
  if (dataQuality < .8) reasons.push('Qualidade de dados insuficiente');
  if (regime?.type === 'unknown') reasons.push('Regime não identificado');
  return { allowed: reasons.length === 0, reasons };
}
""")

# 3) The lines become a diagnostic view of what the engine is actually using.
# The engine always analyses these levels; the toggle only shows/hides the diagnostic overlay.
path = 'src/content/analysis-visual-overlay.js'
s = read(path)
old = """    const analytics = scannerState.signal?.analytics || {};
    const addHorizontal = (price, label, stroke, dash = '') => {
      const value = num(price);
      if (value == null) return;
      const y = yFor(value);
      if (!Number.isFinite(y) || y < -20 || y > rect.height + 20) return;
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', String(rect.width));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('stroke', stroke); line.setAttribute('stroke-width', '1.5');
      line.setAttribute('opacity', '.82');
      if (dash) line.setAttribute('stroke-dasharray', dash);
      svg.appendChild(line);
      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('x', '8'); text.setAttribute('y', String(Math.max(12, y - 5)));
      text.setAttribute('fill', stroke); text.setAttribute('font-size', '11'); text.setAttribute('font-weight', '700');
      text.textContent = `${label} ${formatPrice(value)}`;
      svg.appendChild(text);
    };

    addHorizontal(scannerState.price, 'Preço atual', '#f4f4f4', '2 5');
    addHorizontal(analytics.resistance, 'Resistência', '#f0b56d', '4 5');
    addHorizontal(analytics.support, 'Suporte', '#79bfff', '4 5');
    addHorizontal(analytics.breakoutHigh, 'Gatilho compra ↑', '#58d6ad', '7 5');
    addHorizontal(analytics.breakoutLow, 'Gatilho venda ↓', '#f07b94', '7 5');
"""
new = """    const analytics = scannerState.signal?.analytics || {};
    const waiting = scannerState.signal?.waitingFor || null;
    const drawnLevels = [];
    const addHorizontal = (price, label, stroke, dash = '', active = false) => {
      const value = num(price);
      if (value == null) return;
      const tolerance = Math.max(Math.abs(value) * 0.000002, 1e-10);
      if (drawnLevels.some(existing => Math.abs(existing - value) <= tolerance)) return;
      drawnLevels.push(value);
      const y = yFor(value);
      if (!Number.isFinite(y) || y < -20 || y > rect.height + 20) return;
      const line = document.createElementNS(svg.namespaceURI, 'line');
      line.setAttribute('x1', '0'); line.setAttribute('x2', String(rect.width));
      line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
      line.setAttribute('stroke', stroke); line.setAttribute('stroke-width', active ? '3' : '1.5');
      line.setAttribute('opacity', active ? '.98' : '.78');
      if (dash) line.setAttribute('stroke-dasharray', dash);
      svg.appendChild(line);
      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('x', '8'); text.setAttribute('y', String(Math.max(12, y - 5)));
      text.setAttribute('fill', stroke); text.setAttribute('font-size', active ? '12' : '11'); text.setAttribute('font-weight', '700');
      text.textContent = `${active ? '▶ ' : ''}${label} ${formatPrice(value)}`;
      svg.appendChild(text);
    };

    addHorizontal(scannerState.price, 'Preço atual', '#f4f4f4', '2 5');
    addHorizontal(analytics.resistance, 'Resistência', '#f0b56d', '4 5');
    addHorizontal(analytics.support, 'Suporte', '#79bfff', '4 5');
    addHorizontal(analytics.breakoutHigh, 'Gatilho compra ↑', '#58d6ad', '7 5', waiting?.type === 'breakout' && waiting?.direction === 'BUY');
    addHorizontal(analytics.breakoutLow, 'Gatilho venda ↓', '#f07b94', '7 5', waiting?.type === 'breakout' && waiting?.direction === 'SELL');
"""
s = replace_once(s, old, new, 'active diagnostic levels')

old = """    badge.textContent = `ATS • ${statusMap[uiState] || uiState} • ${liveScore}/100${seconds != null ? ` • ${Math.round(seconds)}s` : ''}`;
    svg.appendChild(badge);

    const direction = scannerState.signal?.analysisDirection || scannerState.signal?.direction || analytics.trendDirection;
"""
new = """    badge.textContent = `ATS • ${statusMap[uiState] || uiState} • ${liveScore}/100${seconds != null ? ` • ${Math.round(seconds)}s` : ''}`;
    svg.appendChild(badge);
    const regimeType = String(scannerState.signal?.regime?.type || 'unknown');
    const regimeLabel = regimeType === 'uptrend' ? 'Tendência alta' : regimeType === 'downtrend' ? 'Tendência baixa' : regimeType === 'range' ? 'Mercado lateral' : 'Regime identificando';
    const detail = document.createElementNS(svg.namespaceURI, 'text');
    detail.setAttribute('x', '10');
    detail.setAttribute('y', '34');
    detail.setAttribute('fill', '#d7e1ef');
    detail.setAttribute('font-size', '10.5');
    detail.setAttribute('font-weight', '650');
    detail.textContent = `${regimeLabel} • ${waiting?.label ? `Aguardando: ${waiting.label}` : 'Monitorando confirmação'}`;
    svg.appendChild(detail);

    const direction = scannerState.signal?.analysisDirection || scannerState.signal?.direction || analytics.trendDirection;
"""
s = replace_once(s, old, new, 'overlay regime/wait detail')
write(path, s)

# 4) Regression tests for the exact live complaints: early visibility, mobile gaps,
# false range starvation and diagnostic lines.
write('test/live-signal-frequency.test.mjs', r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { marketRegime } from '../src/core/market-regime.js';
import { processSnapshot, resetOrchestrator } from '../src/core/orchestrator.js';

const minute = 60_000;
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8');

function bullish(bucket) {
  return [
    { time: bucket - 4 * minute, open: 1.000, high: 1.020, low: .990, close: 1.018, timeframe: 'M1' },
    { time: bucket - 3 * minute, open: 1.018, high: 1.040, low: 1.010, close: 1.038, timeframe: 'M1' },
    { time: bucket - 2 * minute, open: 1.038, high: 1.060, low: 1.030, close: 1.058, timeframe: 'M1' },
    { time: bucket - minute, open: 1.058, high: 1.080, low: 1.050, close: 1.078, timeframe: 'M1' },
    { time: bucket, open: 1.078, high: 1.115, low: 1.075, close: 1.110, timeframe: 'M1' }
  ];
}

function snapshot(bucket, offset, candles = bullish(bucket)) {
  return {
    platformId: 'casatrade', asset: 'EUR/USD', price: candles.at(-1).close,
    timeframe: 'M1', analysisTimeframe: 'M1', connection: 'online',
    serverTime: bucket + offset, candles
  };
}

test('stable possible signal is visible immediately even before the old 30-second window', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_300_000_000 / minute) * minute;
  const first = processSnapshot(snapshot(bucket, 10_000), { connection: 'online' });
  const second = processSnapshot(snapshot(bucket, 11_000), { connection: 'online' });
  assert.notEqual(first.signal.uiState, 'POSSIBLE_BUY');
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
  assert.ok(second.signal.secondsRemaining > 30);
});

test('mobile-throttled second observation can still complete the two-hit pre-signal', () => {
  resetOrchestrator();
  const bucket = Math.floor(1_800_310_000_000 / minute) * minute;
  processSnapshot(snapshot(bucket, 12_000), { connection: 'online' });
  const second = processSnapshot(snapshot(bucket, 18_000), { connection: 'online' });
  assert.equal(second.signal.uiState, 'POSSIBLE_BUY');
});

test('slow but consistent twenty-candle drift is a trend, not automatically range', () => {
  const candles = [];
  for (let i = 0; i < 20; i++) {
    const open = 1.1000 + i * 0.00018;
    const close = open + 0.00012;
    candles.push({ open, high: close + 0.00018, low: open - 0.00018, close });
  }
  const regime = marketRegime(candles);
  assert.equal(regime.type, 'uptrend');
  assert.ok(regime.efficiency >= .48);
});

test('overlay shows the levels and live engine state used for analysis', () => {
  const overlay = read('src/content/analysis-visual-overlay.js');
  for (const label of ['Preço atual', 'Resistência', 'Suporte', 'Gatilho compra', 'Gatilho venda', 'Aguardando:', 'Tendência alta', 'Mercado lateral']) {
    assert.ok(overlay.includes(label), `missing overlay diagnostic: ${label}`);
  }
  assert.match(overlay, /waiting\?\.type === 'breakout'/);
  assert.match(overlay, /pointerEvents = 'none'/);
});
''')

print('live signal flow and diagnostic overlay patch applied')
