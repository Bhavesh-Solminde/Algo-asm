/**
 * Intraday volatility seasonality. Real markets are not equally busy all day:
 * currencies are quiet in the late-US / early-Asia hours and peak at the London
 * open and the London–New York overlap, crypto is busiest when US equities
 * open, and stock indices spike at their own open. Without this a synthetic
 * chart moves the same amount at 03:00 and 13:00 UTC, which is easy to spot.
 *
 * A profile is 24 volatility multipliers, one per UTC hour. `intradayFactor`
 * interpolates linearly between hour midpoints so the level never steps at the
 * top of an hour, and rescales so the mean of the squared factor over a day is
 * 1 — the daily variance stays whatever sigma the caller multiplies it into.
 *
 * Each profile is the median |return| per UTC hour on real data (Oct 2026),
 * weekends and the 21:00 UTC rollover spread spike removed: 14 days of 1m bars
 * for crypto, 60 days of 5m bars for the rest.
 */

/** Crypto: flat-ish around the clock, peaking at the US equity open. */
export const CRYPTO_INTRADAY: readonly number[] = [
  0.9, 1.02, 1.05, 0.87, 0.87, 0.89, 0.84, 0.87, 0.95, 0.85, 0.85, 0.88,
  1.12, 1.48, 1.74, 1.48, 1.15, 1.08, 0.94, 0.88, 0.68, 0.54, 0.58, 0.51,
];

/** European / North-American currency pairs: London open, NY overlap peak. */
export const FX_MAJOR_INTRADAY: readonly number[] = [
  0.74, 0.87, 0.75, 0.66, 0.57, 0.67, 1.13, 1.29, 1.14, 1.02, 0.96, 1.12,
  1.39, 1.62, 1.62, 1.33, 1.04, 0.9, 0.76, 0.74, 0.7, 0.72, 0.49, 0.52,
];

/** Asia-Pacific currency pairs: a busy Tokyo morning as well as the NY peak. */
export const FX_PACIFIC_INTRADAY: readonly number[] = [
  1.4, 1.1, 1.02, 0.71, 0.77, 0.83, 1.08, 1.18, 1.08, 1.04, 0.87, 1.03,
  1.24, 1.33, 1.55, 1.22, 0.94, 0.75, 0.77, 0.67, 0.63, 0.6, 0.62, 0.77,
];

/** Precious metals: Asia open, then the NY open dominates. */
export const METAL_INTRADAY: readonly number[] = [
  1.08, 1.33, 1.07, 0.76, 0.6, 1.1, 0.92, 0.9, 0.91, 0.84, 0.79, 0.88,
  1.38, 1.68, 1.63, 1.34, 0.95, 0.8, 0.91, 0.79, 0.5, 0.48, 0.45, 0.58,
];

/**
 * Stock indices with a 03:45–10:00 UTC session: a sharp opening spike that
 * fades through the day. A real index does not trade outside its session; a
 * game market runs 24/7, so the off-session hours get a quiet after-hours
 * level (0.63 here, ~40% of the in-session average).
 */
export const INDEX_INTRADAY: readonly number[] = [
  0.63, 0.63, 0.63, 2.2, 1.71, 1.31, 1.14, 1.05, 1.08, 1.14, 0.63, 0.63,
  0.63, 0.63, 0.63, 0.63, 0.63, 0.63, 0.63, 0.63, 0.63, 0.63, 0.63, 0.63,
];

const normCache = new WeakMap<readonly number[], number>();

function rms(profile: readonly number[]): number {
  let cached = normCache.get(profile);
  if (cached === undefined) {
    if (profile.length !== 24 || !profile.every((v) => v > 0)) {
      throw new Error("an intraday profile needs 24 positive hourly values");
    }
    cached = Math.sqrt(profile.reduce((s, v) => s + v * v, 0) / 24);
    normCache.set(profile, cached);
  }
  return cached;
}

/** Volatility multiplier for the UTC time `nowSec`. Averages 1 in variance over a day. */
export function intradayFactor(profile: readonly number[], nowSec: number): number {
  const hour = (((nowSec / 3600) % 24) + 24) % 24;
  // Each value sits at its hour's midpoint; blend the two neighbours.
  const x = hour - 0.5;
  const i = Math.floor(x);
  const w = x - i;
  const a = profile[(i + 24) % 24]!;
  const b = profile[(i + 25) % 24]!;
  return ((1 - w) * a + w * b) / rms(profile);
}
