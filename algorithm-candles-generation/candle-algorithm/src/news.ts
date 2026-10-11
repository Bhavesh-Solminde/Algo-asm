/**
 * News shocks — rare volatility surges that fade over several minutes.
 *
 * Real charts have them: a data release or a headline makes the price run
 * further in a few minutes than it normally does in an hour, then trade choppy
 * while it settles. MSM alone reproduces real 1m and 5m tails but leaves the
 * tails of 1h returns 2–3× too thin; these shocks close that gap.
 *
 * A shock arrives at random (more often in the busy hours — the caller scales
 * the arrival rate by the intraday factor) and adds `level` × the long-run
 * volatility on top of whatever MSM is doing, in variance:
 *
 *   sigma² = (msm · intraday)² + level²
 *
 * Adding in variance rather than multiplying keeps a shock that lands in an
 * already busy spell from compounding into an absurd move. `level` decays
 * exponentially; peak sizes are lognormal, so most shocks are modest and a few
 * are large. Like MSM the state is exogenous — it never looks at the price —
 * so the shown and honest paths share it.
 */

export interface NewsParams {
  /** Average shocks per day. */
  readonly perDay: number;
  /** Median extra volatility at the moment of a shock, as a multiple of long-run volatility. */
  readonly peak: number;
  /** Spread of the peak size, in log space. */
  readonly peakSpread: number;
  /** How fast a shock fades: the e-folding time, in seconds. */
  readonly decaySec: number;
}

/** Advance the shock level by dtSec. `rate` scales the arrival rate (e.g. by time of day). */
export function stepNews(
  level: number,
  params: NewsParams,
  dtSec: number,
  rate: number,
  uniform: () => number,
  normal: () => number,
): number {
  let next = level * Math.exp(-dtSec / params.decaySec);
  if (uniform() < (params.perDay * rate * dtSec) / 86400) {
    next += params.peak * Math.exp(params.peakSpread * normal());
  }
  return next;
}

/**
 * Long-run mean of `level²` plus 1 — the factor news raises average variance
 * by. Divide the volatility by its square root so shocks redistribute
 * volatility instead of adding to it, and daily volatility stays calibrated.
 *
 * For shot noise with rate r, peak P and decay τ:
 * E[level²] = r·E[P²]·τ/2 + (r·E[P]·τ)², with E[P] = peak·e^(s²/2) and
 * E[P²] = peak²·e^(2s²).
 */
export function newsVarianceFactor(params: NewsParams): number {
  const r = params.perDay / 86400;
  const s2 = params.peakSpread ** 2;
  const mean = r * params.peak * Math.exp(s2 / 2) * params.decaySec;
  const meanSq = (r * params.peak ** 2 * Math.exp(2 * s2) * params.decaySec) / 2 + mean * mean;
  return 1 + meanSq;
}

/** Combine the base volatility multiplier with the current shock level. */
export function withNews(base: number, level: number, params: NewsParams): number {
  return Math.sqrt((base * base + level * level) / newsVarianceFactor(params));
}
