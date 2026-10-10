// Three things in one file so the whole "up/down steering" story is readable
// end-to-end:
//
//   1. Constants: MAGNET_WINDOW_SEC, MAGNET_CAP, COMMIT_WINDOW_SEC.
//      MAGNET_CAP is in units of per-tick sigma — nothing moves faster than
//      the chart's own natural volatility headroom, so re-convergence hides
//      inside normal movement.
//
//   2. Pure helpers: `expiryMagnet` (quadratic-urgency pull during the last
//      MAGNET_WINDOW_SEC — the pre-GLG shape, kept for comparison) and
//      `reachableMove`, `targetMargin` (used by the resolver when it picks a
//      stamped `targetPrice` at trade open).
//
//   3. The two call-site functions the engine runs every tick:
//        - `blendedMagnet(trades, currentPrice, nowSec, sigma)` — the current
//          per-trade liability-weighted log-gap pull. Multiple live trades
//          vote with their liability for a direction and the result caps at
//          MAGNET_CAP·sigma. This is what returns a non-zero Layer 3 magnet
//          to stepPrice.
//        - `commitSnap(shownPrice, trades, nowSec, maxTickMove)` — the
//          post-stepPrice "the chart MUST end on the right side of the line"
//          correction: in the last COMMIT_WINDOW_SEC of a stamped trade the
//          shown price is deterministically eased toward the trade's target
//          via smoothstep, clamped to the same per-tick move budget so no
//          wick shows up that no viewer could have seen.

import { smoothstep, pathBias, type PathStyle } from "./path-style";

/**
 * The last-window during which the pre-GLG `expiryMagnet` fires. Also used
 * as the "tightening" window for the GLG blended magnet — inside the last
 * MAGNET_WINDOW_SEC the per-tick pull is linearly amplified up to 2× so
 * drift can't overcome the steering in the final seconds.
 */
export const MAGNET_WINDOW_SEC = 30;

/**
 * Hard cap on the magnet, measured in multiples of per-tick sigma. The pull
 * is clamped to ±MAGNET_CAP·sigmaTick, so the steering is always inside
 * normal volatility headroom — a viewer never sees the chart snap.
 */
export const MAGNET_CAP = 1.5;

/**
 * Commit-phase window (seconds). In the last COMMIT_WINDOW_SEC of a
 * governor-stamped live trade the shown price is deterministically eased
 * toward `targetPrice` with a smoothstep weight. Guarantees chart == settled:
 * no z draw, however extreme, can pull the chart back across the target line
 * once we're inside this window.
 */
export const COMMIT_WINDOW_SEC = 6;

/**
 * How far the commit-phase snap in `commitSnap` may shift the shown price in
 * a single tick, in units of the asset's own tickSize. Introduced on prod
 * (PR #51) after users reported "mechanical" single-tick breakouts of 50-150
 * points on NIFTY: the commit snap used to reuse `maxTickMove` (tickSize ×
 * 200 — up to 100 pts/tick) as its backstop, which let a trade whose chart
 * had drifted far from target yank the price in one visible jump. At 10 the
 * snap can nudge the chart ~10 ticks per tick (5 pts at NIFTY) — enough to
 * rescue a typical trade inside the normal magnet envelope, bounded to
 * something that reads as a plausible wick instead of a breakout bar.
 * Trades drifted beyond ceil(COMMIT_WINDOW_SEC / TICK_DT_SEC) ×
 * MAX_COMMIT_SNAP_MOVE_TICKS ticks don't fully rescue; the chart-as-source-
 * of-truth settlement makes those de-facto HONEST at exit.
 */
export const MAX_COMMIT_SNAP_MOVE_TICKS = 10;

/**
 * One stamped live trade — the subset of fields the magnet code reads.
 * `verdict` is HONEST / WIN / LOSS (plus "null-ish" for grandfathered rows
 * that predate the governor). HONEST trades have no path style and never
 * carry a pull. `targetPrice` is the price the resolver chose at open so the
 * verdict is unambiguous after margin.
 */
export interface StampedTrade {
  readonly verdict: "WIN" | "LOSS" | "HONEST";
  readonly pathStyle: PathStyle | null;
  readonly targetPrice: number;
  readonly entrySec: number;
  readonly expirySec: number;
  /** Trade stake in paise/cents. */
  readonly stake: number;
  /** Payout multiplier, as a percentage integer (e.g. 85 for 85%). */
  readonly payoutPct: number;
}

/**
 * Layer-3 magnet for the current tick. Multiple live trades vote with their
 * liability (`stake * payoutPct / 100`) for a log-space direction; the result
 * is capped at MAGNET_CAP × sigmaTick so the pull always hides inside normal
 * volatility headroom.
 *
 *   numer = Σ liability · pathBias(style, elapsedFrac) · log(target/price) · tighten
 *   denom = Σ liability
 *   magnet = clamp( numer / denom , ±MAGNET_CAP·sigmaTick )
 *
 * Grandfathered rows (no verdict / HONEST verdict / no path style / no
 * target) are skipped — they contribute 0 to both numerator and denominator
 * and the chart stays honest wherever all open trades are HONEST.
 */
export function blendedMagnet(input: {
  trades: readonly StampedTrade[];
  currentPrice: number;
  nowSec: number;
  sigmaTick: number;
}): number {
  let numer = 0;
  let denom = 0;
  for (const p of input.trades) {
    if (p.verdict === "HONEST" || p.pathStyle === null) continue;
    const duration = p.expirySec - p.entrySec;
    if (duration <= 0) continue;
    const elapsedFrac = Math.max(0, Math.min(1, (input.nowSec - p.entrySec) / duration));
    const pb = pathBias(p.pathStyle, elapsedFrac);
    if (pb === 0) continue;
    const gap = Math.log(p.targetPrice / input.currentPrice);
    if (!Number.isFinite(gap) || gap === 0) continue;
    const liability = (p.stake * p.payoutPct) / 100;
    // Extra tightening inside the final MAGNET_WINDOW_SEC — ramps from 1 at
    // the start of the window up to 2 at expiry. Stops the pull from being
    // washed out by a sequence of adverse z draws in the last few ticks.
    const secondsLeft = p.expirySec - input.nowSec;
    const tighten =
      secondsLeft > 0 && secondsLeft <= MAGNET_WINDOW_SEC
        ? 1 + (MAGNET_WINDOW_SEC - secondsLeft) / MAGNET_WINDOW_SEC
        : 1;
    numer += liability * pb * gap * tighten;
    denom += liability;
  }
  if (denom === 0) return 0;
  const combined = numer / denom;
  const cap = MAGNET_CAP * input.sigmaTick;
  return combined > cap ? cap : combined < -cap ? -cap : combined;
}

/**
 * Commit-phase snap. Runs AFTER stepPrice has produced a shown price. For the
 * trade that's closest to expiry inside the commit window, ease the shown
 * price toward that trade's target with a smoothstep weight and clamp the
 * displacement to `tickSize × MAX_COMMIT_SNAP_MOVE_TICKS` — a tight visual
 * budget so a far-away target can't jerk the shown price by any amount in
 * one tick, drawing a breakout wick no honest walk could produce.
 *
 * Returns the snapped price. If no trade is inside the window, returns the
 * input price unchanged.
 */
export function commitSnap(input: {
  shownPrice: number;
  trades: readonly StampedTrade[];
  nowSec: number;
  tickSize: number;
}): number {
  let commitTarget: number | null = null;
  let commitSecondsLeft = Infinity;
  for (const p of input.trades) {
    if (p.verdict === "HONEST" || p.pathStyle === null) continue;
    const secondsLeft = p.expirySec - input.nowSec;
    if (
      secondsLeft >= 0 &&
      secondsLeft <= COMMIT_WINDOW_SEC &&
      secondsLeft < commitSecondsLeft
    ) {
      commitSecondsLeft = secondsLeft;
      commitTarget = p.targetPrice;
    }
  }
  if (commitTarget === null) return input.shownPrice;

  const commitProgress = 1 - commitSecondsLeft / COMMIT_WINDOW_SEC;
  const w = smoothstep(commitProgress);
  const blended = (1 - w) * input.shownPrice + w * commitTarget;
  const snapCap = input.tickSize * MAX_COMMIT_SNAP_MOVE_TICKS;
  const delta = blended - input.shownPrice;
  if (Math.abs(delta) > snapCap) {
    return input.shownPrice + Math.sign(delta) * snapCap;
  }
  return blended;
}

/**
 * Layer 3 (pre-governor, kept for comparison). Quadratic urgency —
 * near-invisible early, decisive late. Fires only within MAGNET_WINDOW_SEC
 * of expiry. Capped at MAGNET_CAP × sigmaTick so re-convergence hides inside
 * normal movement.
 *
 * NOT used by the live engine in GLG mode — that path blends per-trade
 * magnets across the whole duration via `blendedMagnet` instead.
 */
export function expiryMagnet(input: {
  currentPrice: number;
  targetPrice: number;
  secondsLeft: number;
  sigmaTick: number;
}): number {
  if (input.secondsLeft > MAGNET_WINDOW_SEC) return 0;
  if (input.currentPrice <= 0 || input.targetPrice <= 0) return 0;
  if (Math.abs(input.currentPrice - input.targetPrice) < 1e-12) return 0;

  const progress = 1 - input.secondsLeft / MAGNET_WINDOW_SEC;
  const urgency = Math.min(1, Math.max(0, progress)) ** 2;

  const gap = Math.log(input.targetPrice / input.currentPrice);
  const pull = urgency * gap;

  const cap = MAGNET_CAP * input.sigmaTick;
  return pull > cap ? cap : pull < -cap ? -cap : pull;
}

/**
 * The furthest the price could plausibly reach in the remaining ticks,
 * measured in log-price space and converted back to an absolute price
 * displacement. Used by the resolver to decide whether the layer-3 target is
 * even in reach, or whether standing pat is the honest answer.
 */
export function reachableMove(input: {
  price: number;
  sigmaTick: number;
  secondsLeft: number;
  dtSec: number;
}): number {
  const ticks = Math.max(0, input.secondsLeft / input.dtSec);
  return input.price * (Math.exp(3 * input.sigmaTick * Math.sqrt(ticks)) - 1);
}
