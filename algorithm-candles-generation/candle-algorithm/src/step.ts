import { initGarch, stepGarch, type GarchParams, type GarchState } from "./garch";
import type { MsmParams } from "./msm";
import type { NewsParams } from "./news";

/**
 * The four-layer tick composer.
 *
 *   L1 base      GBM with GARCH or MSM volatility and short-term momentum —
 *                the honest random walk
 *   L2 drift     a small bounded bias (Plan 04 supplies it; 0 here)
 *   L3 magnet    expiry convergence pull (Plan 04 supplies it; 0 here)
 *   L4 anchor    weak pull toward a real market price
 *
 * All four combine in log space so the price can never go negative, then the
 * total move is clamped so no single tick can draw an implausible candle.
 */

export interface PriceParams {
  /** GARCH(1,1) volatility. Used when `msm` is not set. */
  readonly garch?: GarchParams;
  /**
   * Markov-switching multifractal volatility (src/msm.ts). Takes precedence
   * over `garch`. Its layers live on the asset (they never look at the price)
   * and reach stepPrice through `volScale`.
   */
  readonly msm?: MsmParams;
  /**
   * 24 UTC-hour volatility multipliers (src/intraday.ts). Applied through
   * `volScale` when the caller knows the tick's wall-clock time.
   */
  readonly intraday?: readonly number[];
  /** Rare volatility spikes (src/news.ts). Applied through `volScale`. */
  readonly news?: NewsParams;
  /** Deterministic drift per second, in log space. Usually 0. */
  readonly driftPerSec: number;
  /** Anchor strength per tick. 0 disables anchoring entirely. */
  readonly anchorAlpha: number;
  /** Hard cap on absolute price movement in one tick. */
  readonly maxTickMove: number;
  /**
   * How long, in simulated SECONDS, a push in one direction tends to persist.
   * With independent ticks (0 / omitted — the default) the price zig-zags
   * inside every candle and the wicks end up about as long as the body —
   * bodies average only ~50-57% of the high-low range. Persistence makes
   * consecutive ticks lean the same way, so candles fill with body. Long-run
   * volatility is preserved, so candles get somewhat shorter as this grows.
   * What a value looks like depends on how much simulated time one candle
   * covers: at the live 5s cadence 15 gives 1m bodies ~74%; in example-fast
   * (1s stamps, so each 1m bar holds 5 simulated minutes) 60 gives ~72%.
   * Expressed in time rather than per tick so retuning TICK_DT_SEC keeps the
   * same candle shape.
   */
  readonly trendPersistenceSec?: number;
}

export interface PriceState {
  readonly price: number;
  /** GARCH variance state; null when the asset runs on MSM. */
  readonly garch: GarchState | null;
  /** Unit-variance shock carried from the previous tick (the momentum term). */
  readonly momentum: number;
}

export interface StepPriceInput {
  readonly state: PriceState;
  readonly params: PriceParams;
  readonly dtSec: number;
  /** Standard normal draw for this tick. */
  readonly z: number;
  /**
   * Exogenous volatility multiplier for this tick — MSM layers × intraday
   * factor. Computed once per asset by the caller so the shown and honest
   * paths share it. Defaults to 1.
   */
  readonly volScale?: number;
  /** Layer 2. Log-space bias. Plan 04 bounds this to ±0.25·sigma. */
  readonly driftBias: number;
  /** Layer 3. Log-space pull toward an expiry target. */
  readonly magnet: number;
  /** Layer 4 target, or null when no real quote is available. */
  readonly anchorTarget: number | null;
  /**
   * Layer 5 (Phase 2A). Optional pull toward an INTERNAL reference — the
   * asset's own honest path — for OTC assets that have no external anchor.
   * Same log-space proportional-pull shape as Layer 4 so it composes cleanly
   * with the others.
   */
  readonly selfAnchorTarget?: number | null;
  readonly selfAnchorAlpha?: number;
}

export interface StepPriceOutput {
  readonly state: PriceState;
  readonly price: number;
  /** The conditional volatility used for this tick — Plan 04 needs it to scale bias. */
  readonly sigma: number;
}

/**
 * SECONDS BETWEEN PRICE UPDATES — the single source of truth for how often the
 * chart moves. The engine loop emits exactly one new price every TICK_DT_SEC
 * (loop.ts derives its setTimeout from this) and each update advances the
 * price by this much simulated time.
 *
 * At ~1s the price makes one decisive move and then HOLDS until the next
 * update (the client's brief easing glide settles well inside the interval),
 * instead of the constant sub-second "vibration" you get at small values.
 * Because the per-update move is `sigma·√dt·z`, per-SECOND volatility is
 * unchanged when you retune this — a 1s update simply moves in one larger
 * step rather than many tiny ones.
 */
export const TICK_DT_SEC = 5;

export function perTickSigma(sigma: number, dtSec: number = TICK_DT_SEC): number {
  return sigma * Math.sqrt(dtSec);
}

/** The volatility per √second this asset settles at in the long run. */
export function longRunSigma(params: PriceParams): number {
  if (params.msm) return params.msm.sigma;
  const g = params.garch!;
  return Math.sqrt(g.omega / (1 - g.alpha - g.beta));
}

/** Volatility per √second before `volScale` — GARCH's conditional level, or MSM's sigma. */
export function baseSigma(state: PriceState, params: PriceParams): number {
  return params.msm ? params.msm.sigma : Math.sqrt(state.garch!.sigma2);
}

export function initPriceState(basePrice: number, params: PriceParams): PriceState {
  if (!(basePrice > 0)) {
    throw new Error(`basePrice must be positive, received ${basePrice}`);
  }
  const persistence = params.trendPersistenceSec ?? 0;
  if (!(persistence >= 0)) {
    throw new Error(`trendPersistenceSec must be >= 0, received ${persistence}`);
  }
  if (!params.msm && !params.garch) throw new Error("PriceParams needs garch or msm");
  return { price: basePrice, garch: params.msm ? null : initGarch(params.garch!), momentum: 0 };
}

export function stepPrice(input: StepPriceInput): StepPriceOutput {
  const {
    state,
    params,
    dtSec,
    z,
    volScale = 1,
    driftBias,
    magnet,
    anchorTarget,
    selfAnchorTarget,
    selfAnchorAlpha,
  } = input;

  // Volatility. MSM is exogenous — the caller already folded its layers into
  // volScale. GARCH is endogenous: this tick's shock feeds the next variance.
  let garch = state.garch;
  let sigma: number;
  if (params.msm) {
    sigma = params.msm.sigma * volScale;
  } else {
    const stepped = stepGarch(state.garch!, params.garch!, z);
    garch = stepped.state;
    sigma = stepped.sigma * volScale;
  }

  // Momentum: an AR(1) on the shock so a move tends to continue for about
  // trendPersistenceSec. `momentum` stays unit-variance; `shock` is scaled by
  // sqrt((1 - phi) / (1 + phi)) so the long-run variance of the summed moves is
  // still sigma²·t — trending ticks redistribute volatility, they don't add it.
  // phi = 0 reduces this to the plain independent-z random walk.
  const persistence = params.trendPersistenceSec ?? 0;
  const phi = persistence > 0 ? Math.exp(-dtSec / persistence) : 0;
  const momentum = phi * state.momentum + Math.sqrt(1 - phi * phi) * z;
  const shock = momentum * Math.sqrt((1 - phi) / (1 + phi));

  // L1 + L2 + L3 in log space.
  let logMove =
    params.driftPerSec * dtSec + sigma * Math.sqrt(dtSec) * shock + driftBias + magnet;

  // L4: anchoring is a proportional pull expressed in log space so it composes
  // with the others rather than fighting them.
  if (anchorTarget !== null && params.anchorAlpha > 0 && anchorTarget > 0) {
    logMove += params.anchorAlpha * Math.log(anchorTarget / state.price);
  }

  // L5: OTC self-anchor. Same proportional-pull shape as L4.
  if (
    selfAnchorTarget != null &&
    selfAnchorAlpha != null &&
    selfAnchorAlpha > 0 &&
    selfAnchorTarget > 0
  ) {
    logMove += selfAnchorAlpha * Math.log(selfAnchorTarget / state.price);
  }

  const candidate = state.price * Math.exp(logMove);

  // Clamp the realised move. This is the guard that stops a large magnet or a
  // freak draw from producing a candle nobody would believe.
  const delta = candidate - state.price;
  const clamped =
    Math.abs(delta) > params.maxTickMove
      ? state.price + Math.sign(delta) * params.maxTickMove
      : candidate;

  const price = clamped > 0 ? clamped : state.price;

  return { state: { price, garch, momentum }, price, sigma };
}
