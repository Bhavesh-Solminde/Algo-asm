// How often does a trade win on the honest chart, per strategy? If a simple
// rule beats 50%, players can out-earn the house edge and the economy leaks.
import {
  AssetRegistry,
  findMarket,
  marketParams,
} from "./src/index";

const DAYS = Number(process.env.DAYS ?? 3);

function path(id: string, persistence: number, seed: number): Float64Array {
  const m = findMarket(id)!;
  const reg = new AssetRegistry(seed);
  reg.add({ symbol: id, kind: "OTC", precision: m.precision, basePrice: m.basePrice, params: marketParams(m, "msm", persistence) });
  const start = Date.UTC(2026, 9, 5) / 1000;
  const out = new Float64Array(DAYS * 86400);
  for (let s = 0; s < out.length; s++) out[s] = reg.tick(id, { driftBias: 0, magnet: 0 }, { nowSec: start + s, dtSec: 1 }).price;
  return out;
}

type Strat = (p: Float64Array, t: number) => 1 | -1;
const strategies: Record<string, Strat> = {
  random: () => (Math.random() < 0.5 ? 1 : -1),
  "follow last tick": (p, t) => (p[t]! >= p[t - 1]! ? 1 : -1),
  "follow last 5s": (p, t) => (p[t]! >= p[t - 5]! ? 1 : -1),
  "follow last 60s": (p, t) => (p[t]! >= p[t - 60]! ? 1 : -1),
  "fade last 60s": (p, t) => (p[t]! >= p[t - 60]! ? -1 : 1),
};

for (const id of ["YUR-BUK", "BOT-BUKT", "SHIFTY-50"]) {
  for (const persistence of [0, 2, 4]) {
    const p = path(id, persistence, 7);
    const rows: string[] = [];
    for (const dur of [30, 60, 120]) {
      const cells: string[] = [];
      for (const [, strat] of Object.entries(strategies)) {
        let win = 0, tie = 0, n = 0;
        for (let t = 120; t + dur < p.length; t += 37) {
          const d = strat(p, t);
          const move = p[t + dur]! - p[t]!;
          if (move === 0) tie++;
          else if (Math.sign(move) === d) win++;
          n++;
        }
        cells.push(`${((100 * win) / n).toFixed(1)}/${((100 * tie) / n).toFixed(1)}`.padStart(11));
      }
      rows.push(`  ${String(dur).padStart(3)}s ${cells.join("")}`);
    }
    console.log(`${id} persistence ${persistence}s   win%/tie% →${Object.keys(strategies).map((s) => s.slice(0, 10).padStart(11)).join("")}`);
    console.log(rows.join("\n"));
  }
}
