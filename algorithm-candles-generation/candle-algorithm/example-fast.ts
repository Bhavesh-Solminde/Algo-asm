// No-wait example. Drives the SAME tick + record pipeline the engine uses,
// but by calling registry.tick/record directly in a tight loop with
// synthesised timestamps — so N minutes of market history prints
// instantly. Useful for inspecting the shape of closed candles or
// experimenting with parameter tuning without waiting on the real-time
// cadence used by `npm run example`.
//
// Uses one of the game's fictional markets (src/markets.ts). Every price is
// simulated.

import {
  AssetRegistry,
  findMarket,
  marketParams,
  TIMEFRAME_SEC,
  type Candle,
  type Timeframe,
  type VolModel,
} from "./src/index";

const MARKET = findMarket(process.env.MARKET ?? "YUR-BUK");
if (!MARKET) throw new Error(`unknown MARKET "${process.env.MARKET}" — see src/markets.ts`);
const MODEL = (process.env.MODEL ?? "msm") as VolModel;
const SEED = Number(process.env.SEED ?? 42);
// By default produce two hours of 1m candles — 120 bars — in under a second.
const TOTAL_SECONDS = Number(process.env.MINUTES ?? 120) * 60;
const STEP_SECONDS = 1;
const PERSISTENCE = Number(process.env.PERSISTENCE ?? (MODEL === "msm" ? 4 : 10));

const registry = new AssetRegistry(SEED);
registry.add({
  symbol: MARKET.id,
  kind: "OTC",
  precision: MARKET.precision,
  basePrice: MARKET.basePrice,
  params: marketParams(MARKET, MODEL, PERSISTENCE),
});

const start = Math.floor(Date.now() / 1000);
const closedByTf = new Map<Timeframe, Candle[]>();
const p = (x: number): string => x.toFixed(MARKET.precision);

console.log(
  `candle-algorithm fast example — ${MODEL.toUpperCase()}, seed ${SEED}, ${TOTAL_SECONDS}s of synthetic time`,
);
console.log(`market: ${MARKET.name} (simulated)  base: ${p(MARKET.basePrice)}\n`);

for (let dt = 0; dt < TOTAL_SECONDS; dt += STEP_SECONDS) {
  const nowSec = start + dt;
  const out = registry.tick(MARKET.id, { driftBias: 0, magnet: 0 }, { nowSec, dtSec: STEP_SECONDS });
  const closed = registry.record(MARKET.id, nowSec, out.price);
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
    console.log(`  @ ${openIso}  O ${p(c.o)}  H ${p(c.h)}  L ${p(c.l)}  C ${p(c.c)}`);
  }
}

const forming1m = registry.formingCandle(MARKET.id, "1m");
if (forming1m) {
  console.log(
    `\nforming 1m: O ${p(forming1m.o)}  H ${p(forming1m.h)}  L ${p(forming1m.l)}  C ${p(forming1m.c)}`,
  );
}
