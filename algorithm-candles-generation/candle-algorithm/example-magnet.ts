// Magnet / up-down demo. Opens one 60-second stamped WIN trade, picks a
// target 5 ticks above entry, runs the tick loop (one draw per simulated
// second to keep output tight), and prints:
//
//   - the honest random walk's exit price      — what WOULD have happened
//   - the shown price's exit                   — where the governor landed it
//   - the per-second shown vs honest trace
//
// You should see the shown path drift away from the target early (FEINT) or
// wander around entry (OSCILLATE), then converge in the last window and snap
// to target in the last COMMIT_WINDOW_SEC seconds. The honest path meanwhile
// is a free random walk that lands wherever its z draws point.
//
//   npm run example:magnet
//   STYLE=DIRECT SEED=7 npm run example:magnet

import {
  AssetRegistry,
  blendedMagnet,
  commitSnap,
  COMMIT_WINDOW_SEC,
  MAGNET_WINDOW_SEC,
  TICK_DT_SEC,
  type StampedTrade,
  type PathStyle,
} from "./src/index";

const SYMBOL = "AUDNZD_OTC";
const SEED = Number(process.env.SEED ?? 7);
const BASE_PRICE = 1.1750;
const PRECISION = 5;
const TICK_SIZE = 0.00001;
const MAX_TICK_MOVE = TICK_SIZE * 200;
const DURATION_SEC = 60;
const TARGET_OFFSET_TICKS = 5;
const STYLE: PathStyle = (process.env.STYLE as PathStyle) ?? "FEINT";
const STAKE = 100_00; // ₹100 in paise
const PAYOUT_PCT = 85;

const registry = new AssetRegistry(SEED);
registry.add({
  symbol: SYMBOL,
  kind: "OTC",
  precision: PRECISION,
  basePrice: BASE_PRICE,
  params: {
    garch: { omega: 1e-10, alpha: 0.08, beta: 0.9 },
    driftPerSec: 0,
    anchorAlpha: 0,
    maxTickMove: MAX_TICK_MOVE,
    trendPersistenceSec: 10, // ~70% body / ~30% wick
  },
});

const nowSec = Math.floor(Date.now() / 1000);
const entrySec = nowSec;
const expirySec = entrySec + DURATION_SEC;
const entryPrice = BASE_PRICE;
const targetPrice = +(entryPrice + TARGET_OFFSET_TICKS * TICK_SIZE).toFixed(PRECISION);

const trade: StampedTrade = {
  verdict: "WIN",
  pathStyle: STYLE,
  targetPrice,
  entrySec,
  expirySec,
  stake: STAKE,
  payoutPct: PAYOUT_PCT,
};

console.log(
  `magnet demo — symbol ${SYMBOL}  seed ${SEED}  style ${STYLE}\n` +
    `  entry  ${entryPrice.toFixed(PRECISION)}  @ t+0s\n` +
    `  target ${targetPrice.toFixed(PRECISION)}  @ t+${DURATION_SEC}s  (${TARGET_OFFSET_TICKS} ticks above entry)\n`,
);
console.log(`  ts   shown     honest    gap(ticks)  state`);

function stageLabel(secondsLeft: number): string {
  if (secondsLeft <= COMMIT_WINDOW_SEC) return "commit";
  if (secondsLeft <= MAGNET_WINDOW_SEC) return "tighten";
  return "early";
}

const STAMP_SEC = 1;
for (let dt = STAMP_SEC; dt <= DURATION_SEC; dt += STAMP_SEC) {
  const simSec = entrySec + dt;
  const asset = registry.all()[0]!;
  const sigmaTick = Math.sqrt(asset.state.garch.sigma2) * Math.sqrt(TICK_DT_SEC);

  const magnet = blendedMagnet({
    trades: [trade],
    currentPrice: asset.state.price,
    nowSec: simSec,
    sigmaTick,
  });

  const out = registry.tick(SYMBOL, { driftBias: 0, magnet });

  const snapped = commitSnap({
    shownPrice: out.price,
    trades: [trade],
    nowSec: simSec,
    tickSize: TICK_SIZE,
  });
  if (snapped !== out.price) {
    asset.state = { ...asset.state, price: snapped };
  }
  const shown = +snapped.toFixed(PRECISION);
  registry.record(SYMBOL, simSec, shown);

  const honest = +asset.honestState.price.toFixed(PRECISION);
  const gapTicks = Math.round((shown - entryPrice) / TICK_SIZE);
  console.log(
    `  ${String(dt).padStart(3)}  ${shown.toFixed(PRECISION)}  ${honest.toFixed(PRECISION)}  ${String(gapTicks).padStart(10)}  ${stageLabel(expirySec - simSec)}`,
  );
}

const asset = registry.all()[0]!;
const shownExit = +asset.state.price.toFixed(PRECISION);
const honestExit = +asset.honestState.price.toFixed(PRECISION);
const settled = shownExit >= targetPrice ? "WIN" : "LOSS";
const honestSettled = honestExit >= targetPrice ? "WIN" : "LOSS";

console.log(
  `\nSettlement:\n` +
    `  shown  ${shownExit.toFixed(PRECISION)}  →  ${settled}  ${
      settled === "WIN"
        ? "(magnet landed it on target)"
        : "(magnet lost — target too far from honest to pull inside the cap)"
    }\n` +
    `  honest ${honestExit.toFixed(PRECISION)}  →  ${honestSettled}  (unbiased path, same seed)\n` +
    `  the gap between the two is the governor's visible footprint`,
);
