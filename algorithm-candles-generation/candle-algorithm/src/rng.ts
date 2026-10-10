/**
 * Seeded PRNG for reproducible price paths. Used ONLY by the price engine so a
 * session can be replayed exactly. Never use this for tokens, session ids, or
 * anything security-bearing — that is node:crypto's job.
 *
 * mulberry32: small, fast, good distribution for simulation purposes.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Standard normal, mean 0, sd 1. */
  normal(): number;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Box-Muller. Cache the second variate rather than discarding it.
  let spare: number | null = null;

  const normal = (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    // Reject exact zero — log(0) is -Infinity.
    while (u === 0) u = next();
    while (v === 0) v = next();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    spare = r * Math.sin(theta);
    return r * Math.cos(theta);
  };

  return { next, normal };
}
