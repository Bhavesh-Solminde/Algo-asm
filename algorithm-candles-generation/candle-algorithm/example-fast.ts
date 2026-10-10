// No-wait example. Drives the SAME tick + record pipeline the engine uses,
// but by calling registry.tick/record directly in a tight loop with
// synthesised timestamps — so N minutes of market history prints
// instantly. Useful for inspecting the shape of closed candles or
// experimenting with parameter tuning without waiting on the real-time
// cadence used by `npm run example`.

import {
  AssetRegistry,
  TIMEFRAME_SEC,
  type Candle,
  type Timeframe,
} from "./src/index";

const SYMBOL = "AUDNZD_OTC";
const SEED = Number(process.env.SEED ?? 42);
// By default produce two hours of 1m candles — 120 bars — in under a second.
const TOTAL_SECONDS = Number(process.env.MINUTES ?? 120) * 60;
const STEP_SECONDS = 1;

const registry = new AssetRegistry(SEED);
registry.add({
  symbol: SYMBOL,
  kind: "OTC",
  precision: 5,
  basePrice: 1.1750,
  params: {
    garch: { omega: 1e-10, alpha: 0.08, beta: 0.9 },
    driftPerSec: 0,
    anchorAlpha: 0,
    maxTickMove: 0.002,
  },
});

const start = Math.floor(Date.now() / 1000);
const closedByTf = new Map<Timeframe, Candle[]>();

console.log(
  `candle-algorithm fast example — seed ${SEED}, ${TOTAL_SECONDS}s of synthetic time`,
);
console.log(`symbol: ${SYMBOL}  base: 1.17500\n`);

for (let dt = 0; dt < TOTAL_SECONDS; dt += STEP_SECONDS) {
  const nowSec = start + dt;
  const out = registry.tick(SYMBOL, { driftBias: 0, magnet: 0 });
  const closed = registry.record(SYMBOL, nowSec, out.price);
  for (const c of closed) {
    const prev = closedByTf.get(c.timeframe) ?? [];
    prev.push(c.candle);
    closedByTf.set(c.timeframe, prev);
  }
}

for (const tf of Object.keys(TIMEFRAME_SEC) as Timeframe[]) {
  const bars = closedByTf.get(tf) ?? [];
  // How much of each candle's high-low range is body (the rest is wick).
  const ranged = bars.filter((c) => c.h > c.l);
  const bodyPct =
    ranged.length === 0
      ? 100
      : (100 * ranged.reduce((s, c) => s + Math.abs(c.c - c.o) / (c.h - c.l), 0)) /
        ranged.length;
  console.log(
    `\n${tf} — ${bars.length} closed candles, body averages ${bodyPct.toFixed(0)}% of range`,
  );
  for (const c of bars.slice(-10)) {
    const openIso = new Date(c.openTs * 1000).toISOString().slice(11, 19);
    console.log(
      `  @ ${openIso}  O ${c.o.toFixed(5)}  H ${c.h.toFixed(5)}  L ${c.l.toFixed(5)}  C ${c.c.toFixed(5)}`,
    );
  }
}

const forming1m = registry.formingCandle(SYMBOL, "1m");
if (forming1m) {
  console.log(
    `\nforming 1m: O ${forming1m.o.toFixed(5)}  H ${forming1m.h.toFixed(5)}  L ${forming1m.l.toFixed(5)}  C ${forming1m.c.toFixed(5)}`,
  );
}
