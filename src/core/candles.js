export class CandleBuilder {
  constructor(timeframeMs = 60000) {
    this.timeframeMs = timeframeMs;
    this.current = null;
    this.closed = [];
  }

  push(price, timestamp = Date.now()) {
    price = Number(price);
    if (!Number.isFinite(price)) return null;
    const bucket = Math.floor(timestamp / this.timeframeMs) * this.timeframeMs;
    if (!this.current || this.current.time !== bucket) {
      const closed = this.current;
      this.current = { time: bucket, open: price, high: price, low: price, close: price, ticks: 1 };
      if (closed) {
        this.closed.push(Object.freeze({ ...closed }));
        if (this.closed.length > 1000) this.closed.shift();
      }
      return closed || null;
    }
    this.current.high = Math.max(this.current.high, price);
    this.current.low = Math.min(this.current.low, price);
    this.current.close = price;
    this.current.ticks++;
    return null;
  }

  seed(candles = []) {
    if (!Array.isArray(candles) || !candles.length) return 0;
    const byTime = new Map(this.closed.map(c => [Number(c.time), { ...c }]));
    const rows = [...candles].map((raw, index) => ({ raw, index })).sort((a, b) => {
      let ta = Number(a.raw?.time ?? a.raw?.timestamp);
      let tb = Number(b.raw?.time ?? b.raw?.timestamp);
      if (ta > 0 && ta < 1e12) ta *= 1000;
      if (tb > 0 && tb < 1e12) tb *= 1000;
      return ta - tb || a.index - b.index;
    });
    for (const { raw } of rows) {
      let t = Number(raw?.time ?? raw?.timestamp);
      if (Number.isFinite(t) && t > 0 && t < 1e12) t *= 1000;
      if (!Number.isFinite(t) || t <= 0) continue;
      const time = Math.floor(t / this.timeframeMs) * this.timeframeMs;
      const open = Number(raw?.open), high = Number(raw?.high), low = Number(raw?.low), close = Number(raw?.close);
      if (![open, high, low, close].every(Number.isFinite)) continue;
      if (this.current && time >= this.current.time) continue;
      const ticks = Number(raw?.ticks) || 1;
      const previous = byTime.get(time);
      if (!previous) {
        byTime.set(time, { time, open, high, low, close, ticks });
      } else {
        previous.high = Math.max(previous.high, high);
        previous.low = Math.min(previous.low, low);
        previous.close = close;
        previous.ticks = Number(previous.ticks || 0) + ticks;
        byTime.set(time, previous);
      }
    }
    this.closed = [...byTime.values()]
      .sort((a, b) => a.time - b.time)
      .slice(-1000)
      .map(c => Object.freeze({ ...c }));
    return this.closed.length;
  }

  snapshot() {
    return { current: this.current ? { ...this.current } : null, closed: [...this.closed] };
  }
}

export const TIMEFRAMES = {
  S5: 5000, S15: 15000, S30: 30000,
  M1: 60000, M2: 120000, M5: 300000, M15: 900000, M30: 1800000,
  H1: 3600000, H4: 14400000
};
