// Shape of the per-tick pull toward a stamped trade's `targetPrice`.
// `pathBias(style, t)` returns a scalar in roughly [-1, +1] that the engine's
// per-tick magnet multiplies by log(target/current). Positive pulls toward
// the target; negative pushes away (that's how FEINT's early phase looks like
// the chart is going the wrong way).
//
// Pure. `rng` on `pickStyle` is a caller-injected uniform [0, 1) so tests can
// pin the choice.

export type PathStyle = "DIRECT" | "OSCILLATE" | "FEINT";

/** Cubic ease-in-out: f(0)=0, f(1)=1, f'(0)=f'(1)=0. Bounded to [0, 1]. */
export function smoothstep(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x * x * (3 - 2 * x);
}

/**
 * Signed pull toward the target.
 *
 *   DIRECT     ramps smoothly from entry — a market that made its mind up.
 *   OSCILLATE  wanders around entry for the first 60%, then converges.
 *   FEINT      drives AWAY for the first 35%, then reverses and converges.
 *              Looks like a real fake-out before the "right" direction wins.
 *
 * @param style        one of DIRECT / OSCILLATE / FEINT
 * @param elapsedFrac  (now - entrySec) / (expirySec - entrySec), in [0, 1]
 */
export function pathBias(style: PathStyle, elapsedFrac: number): number {
  const t = Math.max(0, Math.min(1, elapsedFrac));

  switch (style) {
    case "DIRECT":
      // Ramps in at 1.5× the elapsed fraction, capped at 1. Almost always
      // pulling; the chart feels like it decided early.
      return Math.min(1, t * 1.5);

    case "OSCILLATE": {
      // 60% wander using a small-amplitude sine (four full cycles), then
      // convergence over the remaining 40% via smoothstep.
      if (t < 0.6) return 0.15 * Math.sin(t * 8 * Math.PI);
      return smoothstep((t - 0.6) / 0.4);
    }

    case "FEINT": {
      // First 35%: negative pull that grows from 0 to -1 (chart heads the
      // wrong way). Remaining 65%: positive pull from 0 to 1 — the market
      // "comes to its senses" and resolves toward target.
      if (t < 0.35) return -smoothstep(t / 0.35);
      return smoothstep((t - 0.35) / 0.65);
    }
  }
}

/**
 * Pick a style for a new live trade. HONEST trades (unbiased reference) skip
 * this entirely and don't carry a path style at all; the caller enforces that.
 *
 *   ≤ 5s   → DIRECT (no drama fits in 5 seconds).
 *   ≤ 20s  → 65% OSCILLATE, 35% DIRECT.
 *   > 20s  → 35% FEINT, 45% OSCILLATE, 20% DIRECT.
 */
export function pickStyle(
  durationSec: number,
  rng: () => number,
): PathStyle {
  if (durationSec <= 5) return "DIRECT";

  const r = rng();
  if (durationSec <= 20) {
    return r < 0.65 ? "OSCILLATE" : "DIRECT";
  }
  if (r < 0.35) return "FEINT";
  if (r < 0.8) return "OSCILLATE";
  return "DIRECT";
}
