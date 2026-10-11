// This is the engine side: one in-memory asset ticking forward every
// TICK_DT_SEC seconds. Each tick draws one z from the shared RNG, advances the
// price with stepPrice(), and feeds the SHOWN price into every timeframe's
// CandleAggregator. Candles that close here are what the client sees as
// `candle:close` messages.
//
// Three detail choices to notice:
//
//   1. One RNG per registry, not per asset. Every asset shares the stream, so
//      a replay of the full session is reproducible from a single seed.
//   2. `honestState` is a parallel path advanced from the SAME `z` each tick,
//      but with driftBias and magnet forced to 0. That path is what the
//      shadow ledger compares against — "what the market would have done
//      unbiased".
//   3. Candles are recorded from the SHOWN price AFTER any commit-phase snap
//      the loop applies (see loop.ts in the engine). Recording the pre-snap
//      price would put highs or lows into candles that no viewer ever saw as
//      a live price, drawing phantom wicks when the bar closed.

import { CandleAggregator, type Candle } from "./candles";
import { intradayFactor } from "./intraday";
import { initMsm, msmMultiplier, stepMsm, type MsmState } from "./msm";
import { stepNews, withNews } from "./news";
import { createRng, type Rng } from "./rng";
import {
  baseSigma,
  initPriceState,
  stepPrice,
  TICK_DT_SEC,
  type PriceParams,
  type PriceState,
} from "./step";

export type Timeframe = "1m" | "5m" | "15m" | "1h";

export const TIMEFRAME_SEC: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
};

export interface LiveAsset {
  readonly symbol: string;
  readonly kind: "REAL" | "OTC";
  readonly precision: number;
  readonly params: PriceParams;
  state: PriceState;
  honestState: PriceState;
  /** MSM layers, shared by the shown and honest paths. Null on GARCH assets. */
  vol: MsmState | null;
  /** Current news-shock level (0 = calm), shared by both paths. */
  news: number;
  anchor: number | null;
  readonly aggregators: Map<Timeframe, CandleAggregator>;
}

/** When a tick happens. Both fields are optional. */
export interface TickClock {
  /** Wall-clock time of the tick (epoch seconds) — drives the intraday profile. */
  readonly nowSec?: number;
  /** Simulated seconds this tick covers. Defaults to TICK_DT_SEC. */
  readonly dtSec?: number;
}

export interface TickBias {
  /** Layer 2. driftBias (±0.25·sigma) from book imbalance. */
  readonly driftBias: number;
  /** Layer 3. Log-space magnet toward an expiry target. */
  readonly magnet: number;
  readonly selfAnchorTarget?: number | null;
  readonly selfAnchorAlpha?: number;
}

export interface ClosedCandle {
  readonly timeframe: Timeframe;
  readonly candle: Candle;
}

export class AssetRegistry {
  private readonly assets = new Map<string, LiveAsset>();
  private readonly rng: Rng;

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  add(asset: {
    symbol: string;
    kind: "REAL" | "OTC";
    precision: number;
    basePrice: number;
    params: PriceParams;
  }): LiveAsset {
    const live: LiveAsset = {
      symbol: asset.symbol,
      kind: asset.kind,
      precision: asset.precision,
      params: asset.params,
      state: initPriceState(asset.basePrice, asset.params),
      honestState: initPriceState(asset.basePrice, asset.params),
      // GARCH assets draw nothing here, so their seeds replay exactly as before.
      vol: asset.params.msm ? initMsm(asset.params.msm, this.rng.next) : null,
      news: 0,
      anchor: null,
      aggregators: new Map(
        (Object.keys(TIMEFRAME_SEC) as Timeframe[]).map((tf) => [
          tf,
          new CandleAggregator(TIMEFRAME_SEC[tf]),
        ]),
      ),
    };
    this.assets.set(asset.symbol, live);
    return live;
  }

  all(): LiveAsset[] {
    return [...this.assets.values()];
  }

  setAnchor(symbol: string, price: number): void {
    const asset = this.assets.get(symbol);
    if (asset) asset.anchor = price;
  }

  /**
   * Volatility per √second right now, before this tick's MSM switches — what
   * the next tick will roughly use. The magnet sizes its cap from this.
   */
  sigmaNow(symbol: string, nowSec?: number): number {
    const asset = this.assets.get(symbol);
    if (!asset) throw new Error(`unknown symbol "${symbol}"`);
    return baseSigma(asset.state, asset.params) * this.volScale(asset, nowSec);
  }

  private volScale(asset: LiveAsset, nowSec: number | undefined): number {
    const { intraday, news } = asset.params;
    let scale = asset.vol ? msmMultiplier(asset.vol) : 1;
    if (intraday && nowSec !== undefined) scale *= intradayFactor(intraday, nowSec);
    return news ? withNews(scale, asset.news, news) : scale;
  }

  /**
   * Advance one asset by a single tick. Updates both the shown and honest paths.
   * `z` is the standard-normal draw this tick consumed — returned so a viewer
   * can show what moved the price.
   */
  tick(
    symbol: string,
    bias: TickBias,
    clock: TickClock = {},
  ): { price: number; sigma: number; z: number } {
    const asset = this.assets.get(symbol);
    if (!asset) throw new Error(`unknown symbol "${symbol}"`);
    const dtSec = clock.dtSec ?? TICK_DT_SEC;

    const { msm, news, intraday } = asset.params;
    if (asset.vol && msm) asset.vol = stepMsm(asset.vol, msm, dtSec, this.rng.next);
    if (news) {
      // Shocks land more often in the busy hours.
      const rate = intraday && clock.nowSec !== undefined ? intradayFactor(intraday, clock.nowSec) : 1;
      asset.news = stepNews(asset.news, news, dtSec, rate, this.rng.next, this.rng.normal);
    }
    const volScale = this.volScale(asset, clock.nowSec);
    const z = this.rng.normal();

    const out = stepPrice({
      state: asset.state,
      params: asset.params,
      dtSec,
      z,
      volScale,
      driftBias: bias.driftBias,
      magnet: bias.magnet,
      anchorTarget: asset.anchor,
      selfAnchorTarget: bias.selfAnchorTarget ?? null,
      selfAnchorAlpha: bias.selfAnchorAlpha ?? 0,
    });

    const honestOut = stepPrice({
      state: asset.honestState,
      params: asset.params,
      dtSec,
      z,
      volScale,
      driftBias: 0,
      magnet: 0,
      anchorTarget: asset.anchor,
      selfAnchorTarget: null,
      selfAnchorAlpha: 0,
    });

    asset.state = out.state;
    asset.honestState = honestOut.state;

    return { price: Number(out.price.toFixed(asset.precision)), sigma: out.sigma, z };
  }

  /**
   * Feed the SHOWN price into every timeframe. Returns whichever candles
   * closed on this tick. Kept separate from `tick` because the engine loop
   * may apply a commit-phase snap AFTER stepping — recording the pre-snap
   * price would put a high/low into a candle that no viewer saw live.
   */
  record(symbol: string, _nowSec: number, price: number): ClosedCandle[] {
    const asset = this.assets.get(symbol);
    if (!asset) throw new Error(`unknown symbol "${symbol}"`);
    const rounded = Number(price.toFixed(asset.precision));
    const closed: ClosedCandle[] = [];
    for (const [timeframe, aggregator] of asset.aggregators) {
      const candle = aggregator.addTick(_nowSec, rounded);
      if (candle) closed.push({ timeframe, candle });
    }
    return closed;
  }

  formingCandle(symbol: string, timeframe: Timeframe): Candle | null {
    return this.assets.get(symbol)?.aggregators.get(timeframe)?.current() ?? null;
  }
}

export interface TickBroadcast {
  tick: (symbol: string, price: number, ts: number) => void;
  candleClose: (symbol: string, timeframe: Timeframe, candle: Candle) => void;
}

/**
 * Start a tick loop that advances every registered asset once per
 * TICK_DT_SEC and emits a `tick` + `candle:close` as they happen. No DB
 * persist, no governor magnet, no commit snap, no sentiment broadcast —
 * just the price-and-candle core so you can see how the tick drives the
 * candle feed.
 */
export function startTickLoop(
  registry: AssetRegistry,
  broadcast: TickBroadcast,
  biasFor: (symbol: string, nowSec: number) => TickBias = () => ({
    driftBias: 0,
    magnet: 0,
  }),
): { stop(): void } {
  let running = true;
  let timer: NodeJS.Timeout | null = null;
  const TICK_MS = Math.round(TICK_DT_SEC * 1000);

  const run = (): void => {
    const startedAt = Date.now();
    const nowSec = Math.floor(startedAt / 1000);

    for (const asset of registry.all()) {
      const bias = biasFor(asset.symbol, nowSec);
      const out = registry.tick(asset.symbol, bias, { nowSec });
      // Build the candle from the SHOWN price — the one the client will see
      // on this exact tick — so no closed bar carries a point the live chart
      // did not draw.
      const closed = registry.record(asset.symbol, nowSec, out.price);

      broadcast.tick(asset.symbol, out.price, nowSec);
      for (const { timeframe, candle } of closed) {
        broadcast.candleClose(asset.symbol, timeframe, candle);
      }
    }

    if (running) {
      const elapsed = Date.now() - startedAt;
      timer = setTimeout(run, Math.max(0, TICK_MS - elapsed));
    }
  };

  run();

  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}
