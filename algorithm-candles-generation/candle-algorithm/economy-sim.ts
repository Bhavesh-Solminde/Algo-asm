// Does the hamoud economy balance? Simulates a population of players over
// several game days and checks the one thing that matters: does the house
// take back what the daily reward hands out, so the supply stays flat?
//
//   npm run economy
//   PLAYERS=250 DAYS=30 PAYOUT=0.5 npm run economy
//   npm run economy -- --steering     # also measure steering accuracy (slow)
//
// Part 1 (--steering) runs the REAL engine: it opens planned trades on the
// real chart and counts how often the steering actually lands them on the
// planned side. Part 2 feeds that miss rate into the ledger simulation.

import {
  AssetRegistry,
  blendedMagnet,
  commitSnap,
  DEFAULT_ECONOMY,
  Economy,
  breakEvenWinRate,
  findMarket,
  marketParams,
  perTickSigma,
  pickStyle,
  type EconomyConfig,
  type Outcome,
  type StampedTrade,
} from "./src/index";

const PLAYERS = Number(process.env.PLAYERS ?? 100);
const DAYS = Number(process.env.DAYS ?? 14);
const SEED = Number(process.env.SEED ?? 42);

const config: EconomyConfig = {
  ...DEFAULT_ECONOMY,
  payoutRate: Number(process.env.PAYOUT ?? DEFAULT_ECONOMY.payoutRate),
  targetWinRate: Number(process.env.WIN_RATE ?? DEFAULT_ECONOMY.targetWinRate),
  drainTarget: Number(process.env.DRAIN ?? DEFAULT_ECONOMY.drainTarget),
  rewardMode: process.env.REWARD_MODE === "grant" ? "grant" : DEFAULT_ECONOMY.rewardMode,
};

/** mulberry32 — the same small PRNG the price engine uses, for repeatable runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const money = (x: number): string => Math.round(x).toLocaleString("en-US");
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

// ---- part 1: how often does the steering land the planned result? ----------

/**
 * Mirrors the per-tick steering in live/server.ts: blendedMagnet into the
 * tick, commitSnap after it, settle on the shown price.
 */
function steeringAccuracy(marketId: string, durationSec: number, trades: number): number {
  const market = findMarket(marketId)!;
  const reg = new AssetRegistry(SEED);
  reg.add({
    symbol: marketId,
    kind: "OTC",
    precision: market.precision,
    basePrice: market.basePrice,
    params: marketParams(market, "msm", 4),
  });
  const pick = rng(SEED + 1);
  const start = Date.UTC(2026, 9, 5) / 1000;
  let landed = 0;
  let done = 0;
  let open: (StampedTrade & { direction: 1 | -1; entry: number; planned: Outcome }) | null = null;
  const asset = reg.all()[0]!;

  for (let s = 1; done < trades; s++) {
    const nowSec = start + s;
    if (!open && s % (durationSec + 5) === 1) {
      const entry = asset.state.price;
      const direction: 1 | -1 = pick() < 0.5 ? 1 : -1;
      const planned: Outcome = pick() < 0.55 ? "WIN" : "LOSS";
      const sigma = reg.sigmaNow(marketId, nowSec);
      const offset = Math.max(market.tickSize, 0.35 * entry * sigma * Math.sqrt(durationSec));
      const toward = direction * offset;
      open = {
        direction,
        entry,
        planned,
        verdict: "WIN",
        pathStyle: pickStyle(durationSec, pick),
        targetPrice: entry + (planned === "WIN" ? toward : -toward),
        entrySec: nowSec,
        expirySec: nowSec + durationSec,
        stake: 100,
      };
    }
    const sigmaTick = perTickSigma(reg.sigmaNow(marketId, nowSec), 1);
    const magnet = open
      ? blendedMagnet({ trades: [open], currentPrice: asset.state.price, nowSec, sigmaTick })
      : 0;
    const out = reg.tick(marketId, { driftBias: 0, magnet }, { nowSec, dtSec: 1 });
    const snapped = open
      ? commitSnap({ shownPrice: out.price, trades: [open], nowSec, tickSize: market.tickSize })
      : out.price;
    if (snapped !== out.price) asset.state = { ...asset.state, price: snapped };
    const shown = +snapped.toFixed(market.precision);
    reg.record(marketId, nowSec, shown);

    if (open && nowSec >= open.expirySec) {
      const move = shown - open.entry;
      const outcome: Outcome =
        move === 0 ? "TIE" : Math.sign(move) === open.direction ? "WIN" : "LOSS";
      if (outcome === open.planned) landed++;
      done++;
      open = null;
    }
  }
  return landed / done;
}

// ---- part 2: the ledger ----------------------------------------------------

interface Profile {
  readonly name: string;
  readonly share: number;
  /** Trades they are willing to place in a day. */
  readonly tradesPerDay: number;
  /** Preferred stake; they drop to what they can afford. */
  readonly stake: number;
  /** They stop for the day once their balance reaches this multiple of the reward. */
  readonly cashOutAt: number;
}

const PROFILES: readonly Profile[] = [
  { name: "casual", share: 0.4, tradesPerDay: 15, stake: 50, cashOutAt: 3 },
  { name: "regular", share: 0.35, tradesPerDay: 60, stake: 100, cashOutAt: 5 },
  { name: "grinder", share: 0.15, tradesPerDay: 300, stake: 100, cashOutAt: 99 },
  { name: "whale", share: 0.07, tradesPerDay: 60, stake: 500, cashOutAt: 5 },
  { name: "bot", share: 0.03, tradesPerDay: 400, stake: 100, cashOutAt: 99 },
];

/**
 * `steerAccuracy` is how often the chart lands the planned result. The rest
 * of the time the trade settles on the honest chart, which a momentum bot
 * wins ~57% of the time and everyone else wins ~50%.
 */
function simulate(steerAccuracy: number, honestWinRate: Record<string, number>): void {
  const start = Date.UTC(2026, 9, 5) / 1000;
  const economy = new Economy(start, config);
  const pick = rng(SEED + 2);
  const roster = PROFILES.flatMap((p) =>
    Array.from({ length: Math.round(PLAYERS * p.share) }, (_, i) => ({
      id: `${p.name}-${i}`,
      profile: p,
    })),
  );

  console.log(
    `\n${roster.length} players · ${DAYS} days · payout ${pct(config.payoutRate)} ` +
      `(break-even win rate ${pct(breakEvenWinRate(config))}) · steering lands ${pct(steerAccuracy)}`,
  );
  console.log(
    "\n" +
      "day".padStart(4) +
      ["issued", "staked", "paid out", "house take", "vs target", "win rate", "supply", "broke"]
        .map((h) => h.padStart(12))
        .join(""),
  );

  let brokeTotal = 0;
  for (let day = 0; day < DAYS; day++) {
    const nowSec = start + day * 86400;
    economy.tick(nowSec);
    for (const { id } of roster) economy.claimDailyReward(id);

    // Interleave players so the controller sees a realistic mixed order.
    const queue = roster.flatMap(({ id, profile }) =>
      Array.from({ length: profile.tradesPerDay }, () => ({ id, profile })),
    );
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(pick() * (i + 1));
      [queue[i], queue[j]] = [queue[j]!, queue[i]!];
    }

    for (const { id, profile } of queue) {
      const account = economy.account(id);
      if (account.balance >= profile.cashOutAt * config.dailyReward) continue; // happy, stops
      const stake = Math.min(profile.stake, Math.floor(account.balance));
      if (stake < 10) continue; // out of hamoud until tomorrow
      if (!economy.placeStake(id, stake)) continue;

      const planned: Outcome = pick() < economy.winRateFor(id) ? "WIN" : "LOSS";
      let outcome: Outcome;
      if (pick() < steerAccuracy) {
        outcome = planned;
      } else {
        // Steering missed: the honest chart decides.
        const honest = honestWinRate[profile.name] ?? 0.5;
        outcome = pick() < honest ? "WIN" : "LOSS";
      }
      economy.settle(id, stake, outcome);
    }

    const s = economy.stats();
    const broke = roster.filter(({ id }) => economy.account(id).balance < 10).length;
    brokeTotal += broke;
    console.log(
      String(day + 1).padStart(4) +
        [
          money(s.issuedToday),
          money(s.stakedToday),
          money(s.paidOutToday),
          money(s.houseNetToday),
          pct(s.drainRatio),
          pct(s.realisedWinRate),
          money(s.supply),
          String(broke),
        ]
          .map((c) => c.padStart(12))
          .join(""),
    );
  }

  const { issued, houseTake } = economy.totals;
  console.log(
    `\ntotal issued ${money(issued)} · total house take ${money(houseTake)} · ` +
      `drift ${money(issued - houseTake)} (${pct((issued - houseTake) / issued)} of issue)`,
  );
  console.log(
    `supply now ${money(economy.supply)} hamoud across ${roster.length} players ` +
      `(${money(economy.supply / roster.length)} each) · ran out on ${(brokeTotal / DAYS).toFixed(0)} player-days per day`,
  );
}

// ---- run -------------------------------------------------------------------

let accuracy = Number(process.env.ACCURACY ?? 0.9);
if (process.argv.includes("--steering")) {
  console.log("steering accuracy on the real engine (planned result vs where the chart landed):");
  const measured: number[] = [];
  for (const id of ["YUR-BUK", "BOT-BUKT", "SHIFTY-50"]) {
    for (const dur of [30, 60]) {
      const a = steeringAccuracy(id, dur, 150);
      measured.push(a);
      console.log(`  ${id.padEnd(12)} ${String(dur).padStart(3)}s  lands ${pct(a)}`);
    }
  }
  accuracy = measured.reduce((s, x) => s + x, 0) / measured.length;
  console.log(`  average ${pct(accuracy)}`);
}

simulate(accuracy, { bot: 0.57 });
