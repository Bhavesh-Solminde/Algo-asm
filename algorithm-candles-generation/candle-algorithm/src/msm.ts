/**
 * Markov-switching multifractal (MSM) volatility — Calvet & Fisher.
 *
 * Volatility is the product of several independent "layers". Each layer holds
 * either m0 or 2 − m0 (so it averages 1) and now and then re-draws its value
 * (a coin flip, so a re-draw changes it half the time). The layers differ only
 * in how often they re-draw: the fastest every few seconds, the slowest about
 * once a day, with the intervals spaced geometrically in between. That is
 * Calvet–Fisher's gamma_k = 1 − (1 − gamma_1)^(b^(k−1)) written with
 * durations in seconds, so retuning the tick cadence keeps the same behaviour.
 *
 * Why it looks real: busy and quiet stretches nest inside each other on every
 * time scale — the long-memory volatility clustering, fat tails and
 * "aggregational Gaussianity" (tails thin out at longer timeframes) that real
 * FX and crypto show. GARCH(1,1) run per tick forgets its volatility within a
 * few dozen ticks, so at candle scale it reads as uniform noise. The fastest
 * layers also make the path inside one candle bursty, which fills candle
 * bodies the way real 1m bars look without adding any trend to returns.
 *
 * The volatility state is exogenous (it never looks at the price), so the
 * shown and honest paths share one MSM state per asset.
 */

export interface MsmParams {
  /** Long-run volatility of log price per √second. */
  readonly sigma: number;
  /** Number of volatility layers. 8 is the usual choice. */
  readonly components: number;
  /** Layer values are m0 or 2 − m0. 1 = no effect; ~1.5 matches real markets. */
  readonly m0: number;
  /** Mean time between re-draws of the fastest layer, in simulated seconds. */
  readonly fastestSec: number;
  /** Mean time between re-draws of the slowest layer, in simulated seconds. */
  readonly slowestSec: number;
}

export interface MsmState {
  /** Current value of each layer, slowest first. */
  readonly layers: readonly number[];
}

function validate(params: MsmParams): void {
  const { sigma, components, m0, fastestSec, slowestSec } = params;
  if (!(sigma > 0)) throw new Error(`msm.sigma must be positive, received ${sigma}`);
  if (!Number.isInteger(components) || components < 1) {
    throw new Error(`msm.components must be a positive integer, received ${components}`);
  }
  if (!(m0 > 0 && m0 < 2)) throw new Error(`msm.m0 must be in (0, 2), received ${m0}`);
  if (!(fastestSec > 0 && slowestSec >= fastestSec)) {
    throw new Error(`msm needs 0 < fastestSec <= slowestSec, received ${fastestSec}, ${slowestSec}`);
  }
}

/** Mean re-draw interval of each layer, slowest first, geometric spacing. */
export function msmDurations(params: MsmParams): number[] {
  const { components, fastestSec, slowestSec } = params;
  if (components === 1) return [slowestSec];
  return Array.from(
    { length: components },
    (_, k) => slowestSec * (fastestSec / slowestSec) ** (k / (components - 1)),
  );
}

const drawLayer = (m0: number, uniform: () => number): number => (uniform() < 0.5 ? m0 : 2 - m0);

export function initMsm(params: MsmParams, uniform: () => number): MsmState {
  validate(params);
  return { layers: Array.from({ length: params.components }, () => drawLayer(params.m0, uniform)) };
}

/** sqrt(product of layers) — its square averages 1, so sigma stays the long-run level. */
export function msmMultiplier(state: MsmState): number {
  return Math.sqrt(state.layers.reduce((a, b) => a * b, 1));
}

/** Advance every layer by dtSec. Consumes exactly one uniform per layer plus one per re-draw. */
export function stepMsm(
  state: MsmState,
  params: MsmParams,
  dtSec: number,
  uniform: () => number,
): MsmState {
  const durations = msmDurations(params);
  const layers = state.layers.map((value, k) =>
    uniform() < 1 - Math.exp(-dtSec / durations[k]!) ? drawLayer(params.m0, uniform) : value,
  );
  return { layers };
}
