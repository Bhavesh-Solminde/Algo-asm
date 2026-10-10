/**
 * GARCH(1,1) conditional variance, computed as the stochastic recurrence
 * equation sigma2(t) = omega + (alpha * z(t-1)^2 + beta) * sigma2(t-1) —
 * algebraically the same recursion as the textbook
 * sigma2(t) = omega + alpha * eps(t-1)^2 + beta * sigma2(t-1), just derived
 * from the *previous* sigma2 and shock rather than a stored eps: `sigma`
 * (this step's conditional volatility) is known before the shock, so
 * `stepGarch` recomputes eps = sigma * z fresh each call instead of reading
 * it back from state.
 *
 * Requires alpha + beta < 1 for stationarity. This is the term that gives the
 * synthetic series realistic volatility clustering; without it, candles look
 * uniformly noisy and read as fake immediately.
 */

export interface GarchParams {
  readonly omega: number;
  readonly alpha: number;
  readonly beta: number;
}

export interface GarchState {
  readonly sigma2: number;
  /** The realized shock (sigma * z) from the most recent step. Informational
   * only — `stepGarch` derives everything it needs from `sigma2` and the
   * caller's `z`, so this is never read back as an input; it exists so a
   * caller can inspect the last realized shock without recomputing it. */
  readonly lastEps: number;
}

export function initGarch(params: GarchParams): GarchState {
  const persistence = params.alpha + params.beta;
  if (persistence >= 1) {
    throw new Error(
      `GARCH is non-stationary: alpha + beta = ${persistence}, must be < 1`,
    );
  }
  return { sigma2: params.omega / (1 - persistence), lastEps: 0 };
}

export function stepGarch(
  state: GarchState,
  params: GarchParams,
  z: number,
): { state: GarchState; sigma: number } {
  const sigma = Math.sqrt(state.sigma2);
  const eps = sigma * z;
  const sigma2 =
    params.omega +
    params.alpha * eps * eps +
    params.beta * state.sigma2;
  return { state: { sigma2, lastEps: eps }, sigma };
}
