export interface Candle {
  /** Epoch SECONDS at which this candle's bucket opens. */
  readonly openTs: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
}

/** Floors a timestamp to its wall-clock bucket boundary. */
export function bucketStart(tsSec: number, timeframeSec: number): number {
  return Math.floor(tsSec / timeframeSec) * timeframeSec;
}

/**
 * Aggregates finer candles (e.g. 1m) into fixed-width `timeframeSec` buckets on
 * wall-clock boundaries. Input MUST be ascending by `openTs`. Open is the first
 * sub-candle's open, high/low are the extremes, close is the last sub-candle's
 * close. Empty buckets are absent — a gap stays a gap. Used to serve 5m/15m/1h
 * history by resampling the stored 1m candles, so higher timeframes are never
 * empty before the engine has closed one live.
 */
export function resample(candles: readonly Candle[], timeframeSec: number): Candle[] {
  const out: Candle[] = [];
  let cur: Mutable | null = null;
  for (const c of candles) {
    const bucket = bucketStart(c.openTs, timeframeSec);
    if (cur === null || bucket !== cur.openTs) {
      if (cur) out.push({ ...cur });
      cur = { openTs: bucket, o: c.o, h: c.h, l: c.l, c: c.c };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
  }
  if (cur) out.push({ ...cur });
  return out;
}

interface Mutable {
  openTs: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/**
 * Aggregates a tick stream into fixed-width OHLC candles on wall-clock
 * boundaries. Returns a candle only when one CLOSES, so the caller can persist
 * it and broadcast it in the same step.
 */
export class CandleAggregator {
  private forming: Mutable | null = null;
  private lastTs = -Infinity;

  constructor(private readonly timeframeSec: number) {
    if (!Number.isInteger(timeframeSec) || timeframeSec <= 0) {
      throw new Error(`timeframeSec must be a positive integer`);
    }
  }

  addTick(tsSec: number, price: number): Candle | null {
    if (tsSec < this.lastTs) {
      throw new Error(
        `Tick out of order: ${tsSec} follows ${this.lastTs}. The engine clock must be monotonic.`,
      );
    }
    this.lastTs = tsSec;

    const bucket = bucketStart(tsSec, this.timeframeSec);

    if (this.forming === null) {
      this.forming = { openTs: bucket, o: price, h: price, l: price, c: price };
      return null;
    }

    if (bucket === this.forming.openTs) {
      this.forming.h = Math.max(this.forming.h, price);
      this.forming.l = Math.min(this.forming.l, price);
      this.forming.c = price;
      return null;
    }

    // Boundary crossed. Emit the finished candle and start a fresh one. Buckets
    // with no ticks are simply absent rather than synthesised — a gap is real
    // information and inventing flat candles would hide feed outages.
    const closed: Candle = { ...this.forming };
    this.forming = { openTs: bucket, o: price, h: price, l: price, c: price };
    return closed;
  }

  current(): Candle | null {
    return this.forming === null ? null : { ...this.forming };
  }
}
