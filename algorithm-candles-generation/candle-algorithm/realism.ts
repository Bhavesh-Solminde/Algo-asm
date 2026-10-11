// Realism benchmark. For every game market, simulates DAYS of chart time and
// measures the same statistics on the market's real-world counterpart (public
// data from Binance and Yahoo Finance, cached in .realism-cache/). The game
// markets are fictional; the counterparts below are only where each market's
// volatility was calibrated, and this script is the only place they appear.
//
//   npm run realism                    # every market, MSM model
//   MARKET=BOT-BUKT npm run realism    # one market
//   MODEL=garch npm run realism        # the original model, for comparison
//   DAYS=28 SEED=7 npm run realism
//
// Columns (sim vs real):
//   vol/day   volatility per day, % (from 15m returns)
//   kurt      excess kurtosis of bar returns — fat tails (Gaussian = 0)
//   kurt1h    excess kurtosis of 1h returns — tails should thin out, not vanish
//   |r| lag   autocorrelation of |bar return| at 1 bar, 1h and 4h — volatility memory
//   hourCV    how much activity varies across the day
//   body      candle body as a share of the high-low range

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AssetRegistry, GAME_MARKETS, marketParams, type GameMarket, type VolModel } from "./src/index";

type Bar = { t: number; o: number; h: number; l: number; c: number };
interface Source {
  /** Where the real bars come from. */
  readonly fetch: () => Promise<Bar[]>;
  readonly step: number;
  /** Real high/low are usable for the candle-body column. */
  readonly ohlc: boolean;
  /** Only compare UTC [from, to) hours on weekdays — markets that trade a session. */
  readonly session?: readonly [number, number];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, ".realism-cache");
const DAYS = Number(process.env.DAYS ?? 14);
const SEED = Number(process.env.SEED ?? 42);
const MODEL = (process.env.MODEL ?? "msm") as VolModel;
const PERSISTENCE = Number(process.env.PERSISTENCE ?? (MODEL === "msm" ? 4 : 10));

async function binance(symbol: string): Promise<Bar[]> {
  const bars: Bar[] = [];
  let start = Date.now() - 14 * 86400_000;
  while (start < Date.now() - 60_000) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1m&limit=1000&startTime=${start}`;
    const rows = (await (await fetch(url)).json()) as unknown[][];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) bars.push({ t: Number(r[0]) / 1000, o: +r[1]!, h: +r[2]!, l: +r[3]!, c: +r[4]! });
    start = Number(rows.at(-1)![0]) + 60_000;
  }
  return bars;
}

async function yahoo(symbol: string): Promise<Bar[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=60d`;
  const json = (await (await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } })).json()) as {
    chart?: { result?: { timestamp: number[]; indicators: { quote: Record<string, (number | null)[]>[] } }[] };
  };
  const r = json.chart?.result?.[0];
  if (!r) throw new Error(`no Yahoo data for ${symbol}`);
  const q = r.indicators.quote[0]!;
  const bars: Bar[] = [];
  r.timestamp.forEach((t, i) => {
    const b = { t, o: q.open![i]!, h: q.high![i]!, l: q.low![i]!, c: q.close![i]! };
    if ([b.o, b.h, b.l, b.c].every((x) => typeof x === "number" && x > 0)) bars.push(b);
  });
  return bars;
}

const crypto = (symbol: string): Source => ({ fetch: () => binance(symbol), step: 60, ohlc: true });
const yahooFx = (symbol: string): Source => ({ fetch: () => yahoo(symbol), step: 300, ohlc: false });
const index = (symbol: string): Source => ({ fetch: () => yahoo(symbol), step: 300, ohlc: true, session: [4, 10] });

const SOURCES: Record<string, Source> = {
  "ROO-BUK": yahooFx("AUDUSD=X"),
  "YUR-BUK": yahooFx("EURUSD=X"),
  "QID-BUK": yahooFx("GBPUSD=X"),
  "BUK-MOO": yahooFx("CAD=X"),
  "BUK-CHZ": yahooFx("CHF=X"),
  "BUK-NEK": yahooFx("JPY=X"),
  "FOOLS-GOLD": { fetch: () => yahoo("GC=F"), step: 300, ohlc: true },
  "RANK-SHIFTY": index("^NSEBANK"),
  "FUN-SHIFTY": index("NIFTY_FIN_SERVICE.NS"),
  "SHIFTY-50": index("^NSEI"),
  "SHIFTY-IT": index("^CNXIT"),
  "SHIFTY-MIDCAT": index("NIFTY_MIDCAP_100.NS"),
  NONSENSEX: index("^BSESN"),
  "BOT-BUKT": crypto("BTCUSDT"),
  "MEH-BUKT": crypto("ETHUSDT"),
  "BBQ-BUKT": crypto("BNBUSDT"),
  "LOL-BUKT": crypto("SOLUSDT"),
  "NOGE-BUKT": crypto("DOGEUSDT"),
  "BURP-BUKT": crypto("XRPUSDT"),
};

async function realBars(id: string, source: Source): Promise<Bar[]> {
  await mkdir(CACHE, { recursive: true });
  const file = join(CACHE, `${id}.json`);
  if (existsSync(file)) return JSON.parse(await readFile(file, "utf8")) as Bar[];
  const bars = await source.fetch();
  await writeFile(file, JSON.stringify(bars));
  return bars;
}

/** Simulated bars of `step` seconds, ticking once per chart second like the live demo. */
function simBars(market: GameMarket, step: number, seed: number): Bar[] {
  const reg = new AssetRegistry(seed);
  reg.add({
    symbol: market.id,
    kind: "OTC",
    precision: market.precision,
    basePrice: market.basePrice,
    params: marketParams(market, MODEL, PERSISTENCE),
  });
  const start = Date.UTC(2026, 9, 5) / 1000; // a Monday 00:00 UTC
  const bars: Bar[] = [];
  let cur: Bar | null = null;
  for (let s = 1; s <= DAYS * 86400; s++) {
    const t = start + s;
    const { price } = reg.tick(market.id, { driftBias: 0, magnet: 0 }, { nowSec: t, dtSec: 1 });
    const bucket = Math.floor(t / step) * step;
    if (cur && cur.t === bucket) {
      cur.h = Math.max(cur.h, price);
      cur.l = Math.min(cur.l, price);
      cur.c = price;
    } else {
      if (cur) bars.push(cur);
      cur = { t: bucket, o: price, h: price, l: price, c: price };
    }
  }
  return bars;
}

// ---- statistics ------------------------------------------------------------

const mean = (a: number[]): number => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
};
const kurt = (a: number[]): number => {
  const m = mean(a);
  const v = mean(a.map((x) => (x - m) ** 2));
  return mean(a.map((x) => (x - m) ** 4)) / (v * v) - 3;
};
function acf(a: number[], lag: number): number {
  const m = mean(a);
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - m;
    den += d * d;
    if (i + lag < a.length) num += d * (a[i + lag]! - m);
  }
  return num / den;
}

function inSession(t: number, session?: readonly [number, number]): boolean {
  if (!session) return true;
  const d = new Date(t * 1000);
  const h = d.getUTCHours();
  return d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && h >= session[0] && h < session[1];
}

/** k-bar log returns inside gap-free (and in-session) runs. */
function returns(bars: Bar[], step: number, k: number, session?: readonly [number, number]): number[] {
  const out: number[] = [];
  let run: Bar[] = [];
  const flush = (): void => {
    for (let j = k; j < run.length; j += k) out.push(Math.log(run[j]!.c / run[j - k]!.c));
    run = [];
  };
  for (const b of bars) {
    const ok = inSession(b.t, session);
    if (!ok || (run.length > 0 && b.t - run.at(-1)!.t !== step)) flush();
    if (ok) run.push(b);
  }
  flush();
  return out;
}

interface Stats {
  volDay: number;
  kurt: number;
  kurt1h: number;
  acf: number[];
  hourCv: number;
  body: number;
}

function stats(bars: Bar[], step: number, session: readonly [number, number] | undefined, ohlc: boolean): Stats {
  const perHour = 3600 / step;
  const r = returns(bars, step, 1, session);
  const abs = r.map(Math.abs);
  const r15 = returns(bars, step, 900 / step, session);
  const byHour = Array.from({ length: 24 }, () => [] as number[]);
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    const d = new Date(b.t * 1000);
    if (b.t - bars[i - 1]!.t !== step || d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    byHour[d.getUTCHours()]!.push(Math.abs(Math.log(b.c / bars[i - 1]!.c)));
  }
  const hours = byHour.filter((h) => h.length >= 20).map(mean);
  const ranged = bars.filter((b) => b.h > b.l && inSession(b.t, session));
  return {
    volDay: 100 * (sd(r15) / Math.sqrt(900)) * Math.sqrt(86400),
    kurt: kurt(r),
    kurt1h: kurt(returns(bars, step, perHour, session)),
    acf: [1, perHour, 4 * perHour].map((lag) => acf(abs, lag)),
    hourCv: sd(hours) / mean(hours),
    body: ohlc ? mean(ranged.map((b) => Math.abs(b.c - b.o) / (b.h - b.l))) : NaN,
  };
}

// ---- report ------------------------------------------------------------------

const f = (x: number, d: number): string => (Number.isFinite(x) ? x.toFixed(d) : "—");
const pair = (a: number, b: number, d: number): string => `${f(a, d)} / ${f(b, d)}`.padStart(14);

const only = process.env.MARKET;
const markets = GAME_MARKETS.filter((m) => !only || m.id === only);
console.log(`realism — ${MODEL.toUpperCase()} model, ${DAYS} simulated days per market, seed ${SEED}. Each cell: sim / real.\n`);
console.log(
  "market".padEnd(18) +
    "bar".padStart(5) +
    ["vol/day %", "kurt", "kurt 1h", "|r| 1 bar", "|r| 1h", "|r| 4h", "hourCV", "body"].map((h) => h.padStart(14)).join(""),
);
for (const [i, market] of markets.entries()) {
  const source = SOURCES[market.id];
  if (!source) continue;
  let real: Bar[];
  try {
    real = await realBars(market.id, source);
  } catch (err) {
    console.log(market.id.padEnd(18), `real data unavailable: ${(err as Error).message}`);
    continue;
  }
  const s = stats(simBars(market, source.step, SEED * 1000 + i), source.step, source.session, true);
  const r = stats(real, source.step, source.session, source.ohlc);
  console.log(
    market.id.padEnd(18) +
      `${source.step / 60}m`.padStart(5) +
      pair(s.volDay, r.volDay, 2) +
      pair(s.kurt, r.kurt, 1) +
      pair(s.kurt1h, r.kurt1h, 1) +
      pair(s.acf[0]!, r.acf[0]!, 2) +
      pair(s.acf[1]!, r.acf[1]!, 2) +
      pair(s.acf[2]!, r.acf[2]!, 2) +
      pair(s.hourCv, r.hourCv, 2) +
      pair(100 * s.body, 100 * r.body, 0),
  );
}
