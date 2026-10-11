/**
 * The game's markets. Every one is FICTIONAL: the names are made up so nobody
 * mistakes them for a real instrument, the starting prices are round numbers,
 * and the prices come only from the generator. Nothing here tracks or quotes a
 * real market.
 *
 * What is borrowed from reality is behaviour, so the charts look right: each
 * market's volatility (`sigma`) and time-of-day profile were measured on a
 * comparable real instrument in Oct 2026 (see realism.ts for the mapping and
 * the benchmark). Rename freely — only `id` must stay stable.
 */

import {
  CRYPTO_INTRADAY,
  FX_MAJOR_INTRADAY,
  FX_PACIFIC_INTRADAY,
  INDEX_INTRADAY,
  METAL_INTRADAY,
} from "./intraday";
import type { MsmParams } from "./msm";
import type { NewsParams } from "./news";
import type { PriceParams } from "./step";

export type MarketGroup = "Currencies" | "Metals" | "Indices" | "Crypto";

export interface GameMarket {
  /** Stable key — seeds, URLs and trades refer to this. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Second line in the market list. */
  readonly subtitle: string;
  readonly group: MarketGroup;
  /** 2–4 characters drawn in the market's icon. */
  readonly badge: string;
  /** Icon colour. */
  readonly color: string;
  readonly basePrice: number;
  /** Decimal places prices are rounded to. */
  readonly precision: number;
  /** Smallest price step. */
  readonly tickSize: number;
  /** How a price change is counted on screen: pips for currencies, points elsewhere. */
  readonly unit: { readonly size: number; readonly label: string };
  /** Long-run volatility of log price per √second. */
  readonly sigma: number;
  /** MSM layer strength — higher = fatter tails, wilder bursts. */
  readonly m0: number;
  readonly intraday: readonly number[];
}

const PIP = { size: 0.0001, label: "pips" } as const;
const PIP_JPY = { size: 0.01, label: "pips" } as const;
const POINT = { size: 1, label: "pts" } as const;
const CENT = { size: 0.01, label: "¢" } as const;

// Index sigmas are the measured in-session volatility divided by 1.527, the
// in-session level of INDEX_INTRADAY — so the busy hours match the real
// session and the game's after-hours stay quiet.
export const GAME_MARKETS: readonly GameMarket[] = [
  // Currencies — fictional money: Roo, Buck, Yuro, Quid, Moose, Cheese, Neko.
  { id: "ROO-BUK", name: "ROO/BUK", subtitle: "Roo / Buck", group: "Currencies", badge: "ROO", color: "#2f7d5b", basePrice: 0.7, precision: 5, tickSize: 0.00001, unit: PIP, sigma: 1.38e-5, m0: 1.5, intraday: FX_PACIFIC_INTRADAY },
  { id: "YUR-BUK", name: "YUR/BUK", subtitle: "Yuro / Buck", group: "Currencies", badge: "YUR", color: "#3456a8", basePrice: 1.1, precision: 5, tickSize: 0.00001, unit: PIP, sigma: 1.04e-5, m0: 1.5, intraday: FX_MAJOR_INTRADAY },
  { id: "QID-BUK", name: "QID/BUK", subtitle: "Quid / Buck", group: "Currencies", badge: "QID", color: "#7a3fa0", basePrice: 1.3, precision: 5, tickSize: 0.00001, unit: PIP, sigma: 1.09e-5, m0: 1.5, intraday: FX_MAJOR_INTRADAY },
  { id: "BUK-MOO", name: "BUK/MOO", subtitle: "Buck / Moose", group: "Currencies", badge: "MOO", color: "#a8452f", basePrice: 1.4, precision: 5, tickSize: 0.00001, unit: PIP, sigma: 9.65e-6, m0: 1.5, intraday: FX_MAJOR_INTRADAY },
  { id: "BUK-CHZ", name: "BUK/CHZ", subtitle: "Buck / Cheese", group: "Currencies", badge: "CHZ", color: "#c49a1a", basePrice: 0.85, precision: 5, tickSize: 0.00001, unit: PIP, sigma: 1.51e-5, m0: 1.5, intraday: FX_MAJOR_INTRADAY },
  { id: "BUK-NEK", name: "BUK/NEK", subtitle: "Buck / Neko", group: "Currencies", badge: "NEK", color: "#b8325a", basePrice: 150, precision: 3, tickSize: 0.001, unit: PIP_JPY, sigma: 1.97e-5, m0: 1.5, intraday: FX_PACIFIC_INTRADAY },
  // Metals.
  { id: "FOOLS-GOLD", name: "FOOL'S GOLD", subtitle: "FGLD / Buck", group: "Metals", badge: "FG", color: "#b8912e", basePrice: 3000, precision: 2, tickSize: 0.01, unit: CENT, sigma: 4.63e-5, m0: 1.5, intraday: METAL_INTRADAY },
  // Indices of the fictional Shiftyland exchange.
  { id: "RANK-SHIFTY", name: "RANK SHIFTY", subtitle: "Shiftyland", group: "Indices", badge: "RNK", color: "#c46a1f", basePrice: 50000, precision: 2, tickSize: 0.01, unit: POINT, sigma: 2.42e-5, m0: 1.45, intraday: INDEX_INTRADAY },
  { id: "FUN-SHIFTY", name: "FUN SHIFTY", subtitle: "Shiftyland", group: "Indices", badge: "FUN", color: "#c46a1f", basePrice: 25000, precision: 2, tickSize: 0.01, unit: POINT, sigma: 2.46e-5, m0: 1.45, intraday: INDEX_INTRADAY },
  { id: "SHIFTY-50", name: "SHIFTY 50", subtitle: "Shiftyland", group: "Indices", badge: "S50", color: "#c46a1f", basePrice: 20000, precision: 2, tickSize: 0.01, unit: POINT, sigma: 1.88e-5, m0: 1.45, intraday: INDEX_INTRADAY },
  { id: "SHIFTY-IT", name: "SHIFTY IT", subtitle: "Shiftyland", group: "Indices", badge: "SIT", color: "#c46a1f", basePrice: 30000, precision: 2, tickSize: 0.01, unit: POINT, sigma: 4.41e-5, m0: 1.45, intraday: INDEX_INTRADAY },
  { id: "SHIFTY-MIDCAT", name: "SHIFTY MIDCAT 100", subtitle: "Shiftyland", group: "Indices", badge: "CAT", color: "#c46a1f", basePrice: 55000, precision: 2, tickSize: 0.01, unit: POINT, sigma: 2.37e-5, m0: 1.45, intraday: INDEX_INTRADAY },
  { id: "NONSENSEX", name: "NONSENSEX", subtitle: "Shiftyland", group: "Indices", badge: "NSX", color: "#c46a1f", basePrice: 65000, precision: 2, tickSize: 0.01, unit: POINT, sigma: 1.93e-5, m0: 1.45, intraday: INDEX_INTRADAY },
  // Crypto, quoted in BUKT (a fictional Buck-pegged token).
  { id: "BOT-BUKT", name: "BOT/BUKT", subtitle: "Botcoin", group: "Crypto", badge: "BOT", color: "#e08a1e", basePrice: 50000, precision: 2, tickSize: 0.01, unit: POINT, sigma: 5.78e-5, m0: 1.55, intraday: CRYPTO_INTRADAY },
  { id: "MEH-BUKT", name: "MEH/BUKT", subtitle: "Meh-thereum", group: "Crypto", badge: "MEH", color: "#6b72c9", basePrice: 2000, precision: 2, tickSize: 0.01, unit: POINT, sigma: 7.31e-5, m0: 1.55, intraday: CRYPTO_INTRADAY },
  { id: "BBQ-BUKT", name: "BBQ/BUKT", subtitle: "BBQ Coin", group: "Crypto", badge: "BBQ", color: "#c9a227", basePrice: 600, precision: 2, tickSize: 0.01, unit: POINT, sigma: 6.59e-5, m0: 1.55, intraday: CRYPTO_INTRADAY },
  { id: "LOL-BUKT", name: "LOL/BUKT", subtitle: "Lolana", group: "Crypto", badge: "LOL", color: "#8a4fd1", basePrice: 100, precision: 2, tickSize: 0.01, unit: CENT, sigma: 9.33e-5, m0: 1.55, intraday: CRYPTO_INTRADAY },
  { id: "NOGE-BUKT", name: "NOGE/BUKT", subtitle: "Nogecoin", group: "Crypto", badge: "NOG", color: "#b59a3a", basePrice: 0.1, precision: 5, tickSize: 0.00001, unit: PIP, sigma: 1.15e-4, m0: 1.55, intraday: CRYPTO_INTRADAY },
  { id: "BURP-BUKT", name: "BURP/BUKT", subtitle: "Burple", group: "Crypto", badge: "BRP", color: "#4a5568", basePrice: 1, precision: 4, tickSize: 0.0001, unit: PIP, sigma: 1.03e-4, m0: 1.55, intraday: CRYPTO_INTRADAY },
];

export function findMarket(id: string): GameMarket | undefined {
  return GAME_MARKETS.find((m) => m.id === id);
}

/** Which volatility model drives the price. */
export type VolModel = "msm" | "garch";

/** The MSM settings every market shares; only sigma and m0 differ. */
export function marketMsm(market: GameMarket): MsmParams {
  return { sigma: market.sigma, components: 8, m0: market.m0, fastestSec: 1, slowestSec: 3 * 86400 };
}

/**
 * News shocks every market shares: about 1.5 a day, peaking at ~5× normal
 * volatility and fading over ~10 minutes. Brings the tails of 1h returns up
 * toward real FX and crypto without inflating 1m/5m tails (realism.ts).
 */
export const MARKET_NEWS: NewsParams = { perDay: 1.5, peak: 5, peakSpread: 0.5, decaySec: 600 };

/**
 * Engine parameters for one market. "msm" is the realistic model (MSM layers,
 * time-of-day activity, news shocks); "garch" is the original GARCH(1,1) at the
 * same long-run volatility, kept so the two can be compared side by side.
 */
export function marketParams(
  market: GameMarket,
  model: VolModel,
  trendPersistenceSec: number,
): PriceParams {
  const common = {
    driftPerSec: 0,
    anchorAlpha: 0,
    // A backstop well beyond anything the volatility model draws in one second.
    maxTickMove: Math.max(market.tickSize * 20, market.basePrice * market.sigma * 40),
    trendPersistenceSec,
  };
  if (model === "msm") {
    return { ...common, msm: marketMsm(market), intraday: market.intraday, news: MARKET_NEWS };
  }
  const alpha = 0.08;
  const beta = 0.9;
  return { ...common, garch: { omega: market.sigma ** 2 * (1 - alpha - beta), alpha, beta } };
}
