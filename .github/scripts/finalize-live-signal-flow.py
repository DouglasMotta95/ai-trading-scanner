from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(text, old, new, label):
    if old not in text:
        raise AssertionError(f'missing target: {label}')
    return text.replace(old, new, 1)

# 1) Make stability tolerant to mobile throttling, without changing score thresholds.
path = 'src/core/orchestrator.js'
s = read(path)
s = replace_once(s, "const CANDIDATE_MAX_GAP_MS = 3500;", "const CANDIDATE_MAX_GAP_MS = 8000;", 'mobile stability gap')

# Steady directional trend is an accepted confirmation-quality path, using existing trend/momentum metrics.
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

# If a stable pre-signal already exists earlier in the candle, show it immediately instead of hiding it until 30s.
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

# 2) Improve range/trend classification: preserve the range gate, but stop classifying slow consistent trends as range.
write('src/core/market-regime.js', """const finite = value => value == null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function marketRegime(candles = []) {
  const recent = (Array.isArray(candles) ? candles : [])
    .map(candle => ({
      high: finite(candle?.high),
      low: finite(candle?.low),
      close: finite(candle?.close)
    }))
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

  // A true trend may be fast (large displacement) or slow but very consistent.
  // This keeps the range gate, while avoiding the old false-negative where a steady drift
  // was labelled range merely because it did not travel > 7 average candle ranges in 20 candles.
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

# 3) Make the overlay a real diagnostic surface for the engine: current price, support/resistance,
# breakout levels, trend and a compact status explaining what the scanner is using/waiting for.
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

    addHorizontal(analytics.breakoutHigh, 'Rompimento ↑', '#58d6ad', '7 5');
    addHorizontal(analytics.breakoutLow, 'Rompimento ↓', '#f07b94', '7 5');
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

    addHorizontal(analytics.breakoutHigh, 'Rompimento ↑', '#58d6ad', '7 5', waiting?.type === 'breakout' && waiting?.direction === 'BUY');
    addHorizontal(analytics.breakoutLow, 'Rompimento ↓', '#f07b94', '7 5', waiting?.type === 'breakout' && waiting?.direction === 'SELL');
    addHorizontal(analytics.resistance, 'Resistência', '#f5c76b', '4 5');
    addHorizontal(analytics.support, 'Suporte', '#76c7ff', '4 5');
    addHorizontal(scannerState.price, 'Preço atual', '#ffffff', '2 4');
"""
s = replace_once(s, old, new, 'diagnostic horizontal levels')

# Add a status HUD after the trend line block, before render() ends.
old = """    if (direction === 'BUY' || direction === 'SELL') {
      const closes = (Array.isArray(scannerState.candles) ? scannerState.candles.slice(-6) : [])
        .map(row => num(row?.close)).filter(value => value != null);
      const current = num(scannerState.currentCandle?.close) ?? num(scannerState.price);
      if (current != null) closes.push(current);
      if (closes.length >= 2) {
        const xs = closes.map((_, index) => index);
        const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
        const meanY = closes.reduce((a, b) => a + b, 0) / closes.length;
        const denom = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
        let slope = denom > 0 ? xs.reduce((sum, x, index) => sum + (x - meanX) * (closes[index] - meanY), 0) / denom : 0;
        const visibleRange = Math.max(1e-12, Math.max(...closes) - Math.min(...closes));
        if (direction === 'BUY' && slope <= 0) slope = visibleRange / Math.max(4, closes.length * 2);
        if (direction === 'SELL' && slope >= 0) slope = -visibleRange / Math.max(4, closes.length * 2);
        const startPrice = meanY + slope * (0 - meanX);
        const endPrice = meanY + slope * ((closes.length - 1) - meanX);
        const trend = document.createElementNS(svg.namespaceURI, 'line');
        trend.setAttribute('x1', String(rect.width * .12));
        trend.setAttribute('x2', String(rect.width * .88));
        trend.setAttribute('y1', String(yFor(startPrice)));
        trend.setAttribute('y2', String(yFor(endPrice)));
        trend.setAttribute('stroke', direction === 'BUY' ? '#69cfff' : '#ffb46b');
        trend.setAttribute('stroke-width', '2');
        trend.setAttribute('opacity', '.78');
        svg.appendChild(trend);
      }
    }
"""
new = old + """

    const signal = scannerState.signal || {};
    const statusDirection = signal.direction || signal.analysisDirection || 'WAIT';
    const score = Math.round(Number(signal.score || signal.analysisScore || 0));
    const regime = String(signal.regime?.type || 'unknown');
    const regimeLabel = regime === 'uptrend' ? 'tendência de alta' : regime === 'downtrend' ? 'tendência de baixa' : regime === 'range' ? 'lateral' : 'identificando';
    const statusLines = [
      `${scannerState.asset} • ${statusDirection === 'BUY' ? 'COMPRA' : statusDirection === 'SELL' ? 'VENDA' : 'AGUARDAR'} • score ${score}`,
      `Regime: ${regimeLabel}`,
      waiting?.label ? `Scanner: ${waiting.label}` : 'Scanner: monitorando confirmação'
    ];
    const panel = document.createElementNS(svg.namespaceURI, 'g');
    const panelWidth = Math.min(310, Math.max(210, rect.width * .52));
    const panelHeight = 58;
    const panelBg = document.createElementNS(svg.namespaceURI, 'rect');
    panelBg.setAttribute('x', '8'); panelBg.setAttribute('y', '8');
    panelBg.setAttribute('width', String(panelWidth)); panelBg.setAttribute('height', String(panelHeight));
    panelBg.setAttribute('rx', '8'); panelBg.setAttribute('fill', 'rgba(7,12,20,.78)');
    panelBg.setAttribute('stroke', direction === 'BUY' ? '#58d6ad' : direction === 'SELL' ? '#f07b94' : '#8b9bb2');
    panelBg.setAttribute('stroke-width', '1');
    panel.appendChild(panelBg);
    statusLines.forEach((lineText, index) => {
      const text = document.createElementNS(svg.namespaceURI, 'text');
      text.setAttribute('x', '16'); text.setAttribute('y', String(24 + index * 16));
      text.setAttribute('fill', index === 0 ? '#ffffff' : '#c7d2e3');
      text.setAttribute('font-size', index === 0 ? '11.5' : '10.5');
      text.setAttribute('font-weight', index === 0 ? '700' : '600');
      text.textContent = lineText;
      panel.appendChild(text);
    });
    svg.appendChild(panel);
"""
s = replace_once(s, old, new, 'overlay status HUD')
write(path, s)

# 4) Regression tests for signal starvation and overlay diagnostics.
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

test('overlay exposes actual decision levels and scanner status instead of decorative breakout lines only', () => {
  const overlay = read('src/content/analysis-visual-overlay.js');
  assert.match(overlay, /Resistência/);
  assert.match(overlay, /Suporte/);
  assert.match(overlay, /Preço atual/);
  assert.match(overlay, /Regime:/);
  assert.match(overlay, /Scanner:/);
  assert.match(overlay, /waiting\?\.type === 'breakout'/);
  assert.match(overlay, /pointerEvents = 'none'/);
});
''')

print('live signal flow and diagnostic overlay patch applied')
