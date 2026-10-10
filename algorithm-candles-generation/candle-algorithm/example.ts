// Live-cadence walkthrough: ticks every TICK_DT_SEC (5s) real seconds, same
// wiring the engine uses — no network, no DB, no governor. Prints each tick
// and every closed candle. Runs for 30s by default; override with
// `DURATION_MS=120000 npm run example` for two minutes.
//
// For a non-waiting demo that produces an hour of candles instantly, run
// `npm run example:fast` instead.

import {
  AssetRegistry,
  TICK_DT_SEC,
  startTickLoop,
  type Candle,
  type Timeframe,
} from "./src/index";

const SYMBOL = "AUDNZD_OTC";
const SEED = 42;

const registry = new AssetRegistry(SEED);
registry.add({
  symbol: SYMBOL,
  kind: "OTC",
  precision: 5,
  basePrice: 1.1750,
  params: {
    // Realistic-feeling tuning for a quiet FX pair at this precision.
    garch: { omega: 1e-10, alpha: 0.08, beta: 0.9 },
    driftPerSec: 0,
    anchorAlpha: 0,
    maxTickMove: 0.002,
  },
});

const closedByTf = new Map<Timeframe, Candle[]>();

console.log(`candle-algorithm live example — tick every ${TICK_DT_SEC}s`);
console.log(`symbol: ${SYMBOL}  seed: ${SEED}  base: 1.17500\n`);

const loop = startTickLoop(registry, {
  tick: (symbol, price, ts) => {
    const second = new Date(ts * 1000).toISOString().slice(11, 19);
    console.log(`[${second}] ${symbol} tick → ${price.toFixed(5)}`);
  },
  candleClose: (_symbol, timeframe, candle) => {
    const prev = closedByTf.get(timeframe) ?? [];
    prev.push(candle);
    closedByTf.set(timeframe, prev);
    const open = new Date(candle.openTs * 1000).toISOString().slice(11, 19);
    console.log(
      `  ${timeframe} closed @ ${open}  O ${candle.o.toFixed(5)}  H ${candle.h.toFixed(5)}  L ${candle.l.toFixed(5)}  C ${candle.c.toFixed(5)}`,
    );
  },
});

const DURATION_MS = Number(process.env.DURATION_MS ?? 30_000);
setTimeout(() => {
  loop.stop();
  const forming = registry.formingCandle(SYMBOL, "1m");
  console.log(
    forming
      ? `\nforming 1m: O ${forming.o.toFixed(5)}  H ${forming.h.toFixed(5)}  L ${forming.l.toFixed(5)}  C ${forming.c.toFixed(5)}`
      : "\nno forming 1m candle yet",
  );
  console.log(`total 1m candles closed: ${(closedByTf.get("1m") ?? []).length}`);
}, DURATION_MS);
