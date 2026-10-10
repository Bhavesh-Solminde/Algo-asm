// The browser's side of the candle pipeline. It subscribes to the four
// server messages (`candles:history`, `candles:older`, `candle:close`,
// `tick`) and folds each one into an immutable ChartState. The chart canvas
// then reads that state and paints — the forming candle grows under the
// eased live-price glide, and bucket boundaries snap the glide so it never
// paints a phantom wick back to the previous bar's close.

import { TIMEFRAME_SEC, type Timeframe } from "./engine-loop";
import type { Candle } from "./candles";

export { TIMEFRAME_SEC };

/** The ceiling on retained closed candles. */
const MAX_CANDLES = 5000;

export interface ChartState {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly candles: Candle[];
  readonly forming: Candle | null;
  readonly lastPrice: number | null;
  readonly loadingOlder: boolean;
  readonly reachedStart: boolean;
}

export type ServerMessage =
  | { type: "candles:history"; symbol: string; timeframe: Timeframe; candles: Candle[]; forming?: Candle }
  | { type: "candles:older"; symbol: string; timeframe: Timeframe; candles: Candle[]; reachedStart: boolean }
  | { type: "candle:close"; symbol: string; timeframe: Timeframe; candle: Candle }
  | { type: "tick"; symbol: string; price: number; ts: number };

export function initialChartState(symbol: string, timeframe: Timeframe): ChartState {
  return {
    symbol,
    timeframe,
    candles: [],
    forming: null,
    lastPrice: null,
    loadingOlder: false,
    reachedStart: false,
  };
}

/**
 * Fold one server message into chart state. Pure — the candle logic is
 * unit-tested rather than eyeballed on a live chart. Messages for another
 * symbol are ignored: after an asset switch a tick already in flight for the
 * old asset must not paint onto the new chart.
 */
export function applyChartMessage(state: ChartState, message: ServerMessage): ChartState {
  switch (message.type) {
    case "candles:history": {
      if (message.symbol !== state.symbol || message.timeframe !== state.timeframe) return state;
      const candles = message.candles.slice(-MAX_CANDLES);
      const last = candles.at(-1);
      // Prefer the server's seeded forming bar (accurate for a mid-bucket join).
      const seeded =
        message.forming && (!last || message.forming.openTs > last.openTs) ? message.forming : null;
      const forming =
        seeded ?? (state.forming && last && state.forming.openTs <= last.openTs ? null : state.forming);
      return { ...state, candles, forming, loadingOlder: false, reachedStart: false };
    }

    case "candles:older": {
      if (message.symbol !== state.symbol || message.timeframe !== state.timeframe) return state;
      const oldestTs = state.candles[0]?.openTs ?? Infinity;
      // Keep only candles strictly older than what we already hold.
      const older = message.candles.filter((c) => c.openTs < oldestTs);
      const candles =
        older.length === 0 ? state.candles : [...older, ...state.candles].slice(-MAX_CANDLES);
      return { ...state, candles, loadingOlder: false, reachedStart: message.reachedStart };
    }

    case "candle:close": {
      if (message.symbol !== state.symbol || message.timeframe !== state.timeframe) return state;
      const candles = [
        ...state.candles.filter((c) => c.openTs !== message.candle.openTs),
        message.candle,
      ]
        .sort((a, b) => a.openTs - b.openTs)
        .slice(-MAX_CANDLES);
      const forming =
        state.forming && state.forming.openTs <= message.candle.openTs ? null : state.forming;
      return { ...state, candles, forming };
    }

    case "tick": {
      if (message.symbol !== state.symbol) return state;
      const width = TIMEFRAME_SEC[state.timeframe];
      const openTs = Math.floor(message.ts / width) * width;
      const last = state.candles.at(-1);

      // The bucket has already closed; drawing it again would reopen history.
      if (last && openTs <= last.openTs) return { ...state, lastPrice: message.price };

      // Older than the candle already forming: replacing it would hand the
      // chart a bar older than its newest, which lightweight-charts rejects.
      if (state.forming && openTs < state.forming.openTs) return state;

      const forming =
        state.forming && state.forming.openTs === openTs
          ? {
              ...state.forming,
              h: Math.max(state.forming.h, message.price),
              l: Math.min(state.forming.l, message.price),
              c: message.price,
            }
          : { openTs, o: message.price, h: message.price, l: message.price, c: message.price };

      return { ...state, forming, lastPrice: message.price };
    }

    default:
      return state;
  }
}
