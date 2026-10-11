// Live demo server for the trading GAME. Every market is fictional and every
// price is generated here — there is no market feed. Stakes are hamoud, the
// game's coins with no cash value, and nothing is paid out: a trade only ends
// as WIN or LOSS. The page shows a notice saying all of this before anything
// else.
//
// It runs one AssetRegistry tick → record pipeline per market and streams it
// to the browser over Server-Sent Events in the platform's message shapes
// (`candles:history`, `candle:close`, `tick`). The page folds those with
// applyChartMessage — the web app's own client fold — and paints them with
// lightweight-charts. Each browser streams only the market it is looking at,
// plus a light `quotes` message for the market list.
//
// Time is simulated so the demo can fast-forward: each tick advances the chart
// clock by STAMP_SEC, and `speed` sets how many chart seconds pass per real
// second. "Skip" generates a block of ticks instantly.
//
//   npm run live            → http://localhost:5180
//   PORT=4000 SEED=7 npm run live

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import {
  AssetRegistry,
  blendedMagnet,
  commitSnap,
  DEFAULT_ECONOMY,
  Economy,
  breakEvenWinRate,
  GAME_MARKETS,
  intradayFactor,
  longRunSigma,
  marketMsm,
  marketParams,
  msmDurations,
  perTickSigma,
  pickStyle,
  TIMEFRAME_SEC,
  type Candle,
  type EconomyStats,
  type GameMarket,
  type Outcome,
  type LiveAsset,
  type MarketGroup,
  type PathStyle,
  type PriceParams,
  type ServerMessage,
  type StampedTrade,
  type Timeframe,
  type VolModel,
} from "../src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5180);
const SEED = Number(process.env.SEED ?? 42);
// Chart seconds between ticks. A 1m candle is built from 60 ticks.
const STAMP_SEC = 1;
// History generated for every market at start-up and on every rebuild.
const HISTORY_MINUTES = Number(process.env.HISTORY_MINUTES ?? 12 * 60);
const MAX_KEPT = 5000;
const SPEEDS = [1, 10, 60, 300] as const;
// Upper bound for trendPersistenceSec set from the page. Well past the point
// where 1m candles lose their wicks entirely.
const MAX_PERSISTENCE_SEC = 600;
// Browsers can't usefully take more than ~60 frames a second; above that,
// several ticks share one frame.
const MAX_FRAMES_PER_SEC = 60;
// How often the market list's prices refresh, in real milliseconds.
const QUOTES_EVERY_MS = 500;
const TRADE_DURATIONS_SEC = [30, 60, 120] as const;
/** Stake choices, in hamoud (src/economy.ts). */
const STAKES = DEFAULT_ECONOMY.stakes;
const MAX_SETTLED_KEPT = 20;
// A planned trade's target sits this many standard deviations of the
// trade-length move away from entry — about where the original fixed 5-pip
// target sat on the original model.
const TARGET_SIGMAS = 0.35;
// Default momentum per model. 4s with MSM fills bodies to ~62% of the range
// without adding a trend you could measure across candles; 10s was the GARCH
// tuning.
const DEFAULT_PERSISTENCE: Record<VolModel, number> = { msm: 4, garch: 10 };
const WIN_RATE_OPTIONS = [0.25, 0.5, 1.0] as const;
const DAY_SEC = 86400;

export interface Settings {
  readonly model: VolModel;
  readonly speed: number;
  readonly persistence: number;
  readonly paused: boolean;
  /**
   * Probability a new trade is planned as a WIN. `null` hands the choice to
   * the economy controller, which is the real game; a fixed number is a demo
   * override for watching the steering work.
   */
  readonly winRate: number | null;
  /** A winning trade returns stake × (1 + payoutRate). */
  readonly payoutRate: number;
  readonly stakes: readonly number[];
}

/** One player's purse. Each browser gets its own. */
export interface Wallet {
  readonly type: "wallet";
  readonly playerId: string;
  readonly balance: number;
  readonly canClaim: boolean;
  /** Game seconds until the next daily top-up. */
  readonly nextRewardSec: number;
  readonly dailyReward: number;
  readonly stakedToday: number;
  readonly netToday: number;
  readonly tradesToday: number;
  readonly winsToday: number;
}

/** What the page needs to list and format a market. */
export interface MarketInfo {
  readonly id: string;
  readonly name: string;
  readonly subtitle: string;
  readonly group: MarketGroup;
  readonly badge: string;
  readonly color: string;
  readonly precision: number;
  readonly tickSize: number;
  readonly unit: { readonly size: number; readonly label: string };
}

export interface Quote {
  readonly id: string;
  readonly price: number;
  /** Change over the last 24 chart hours (or since the chart began), in percent. */
  readonly changePct: number;
}

/** Everything the page needs to explain one tick. */
export interface TickDetail {
  readonly type: "detail";
  readonly symbol: string;
  readonly ts: number;
  readonly z: number;
  /** Volatility used this tick as a multiple of its long-run level. */
  readonly volMultiple: number;
  /** Time-of-day part of volMultiple (1 on GARCH). */
  readonly intraday: number;
  /** MSM layer values, slowest first; null on GARCH. */
  readonly layers: readonly number[] | null;
  /** News-shock level: extra volatility as a multiple of normal (0 = calm). */
  readonly news: number;
  readonly momentum: number;
  /** Steering pull this tick, in per-tick sigmas (0 with no open trade). */
  readonly steer: number;
  /** How far the commit snap moved the price this tick, in price units. */
  readonly snap: number;
  readonly prevPrice: number;
  readonly price: number;
}

/** A UI-friendly view of an open or settled trade. */
export interface TradeView {
  readonly id: string;
  readonly market: string;
  /** Whose trade it is — the game only shows you your own. */
  readonly player: string;
  readonly direction: "UP" | "DOWN";
  /** The result the game picked when the trade opened; the chart is steered toward it. */
  readonly planned: "WIN" | "LOSS";
  readonly pathStyle: PathStyle;
  readonly entryPrice: number;
  readonly targetPrice: number;
  readonly entrySec: number;
  readonly expirySec: number;
  /** Stake in hamoud, already taken from the player's balance. */
  readonly stake: number;
  /** What a win would return: stake × (1 + payoutRate). */
  readonly toReturn: number;
}

export interface SettledTradeView extends TradeView {
  readonly exitPrice: number;
  /** TIE = the price landed exactly on entry; the stake is refunded. */
  readonly outcome: Outcome;
  /** Hamoud credited back: the full return on a win, the stake on a tie, 0 on a loss. */
  readonly credited: number;
}

export type DemoMessage =
  | ServerMessage
  | TickDetail
  | { type: "settings"; settings: Settings; stampSec: number; layerSecs: number[] }
  | { type: "markets"; markets: MarketInfo[] }
  | { type: "quotes"; quotes: Quote[] }
  | Wallet
  | { type: "economy"; stats: EconomyStats; breakEven: number }
  | { type: "reset" }
  | { type: "trades:snapshot"; open: TradeView[]; settled: SettledTradeView[] }
  | { type: "trade:open"; trade: TradeView }
  | { type: "trade:settle"; trade: SettledTradeView };

interface LiveTrade extends StampedTrade {
  readonly id: string;
  readonly market: string;
  readonly playerId: string;
  readonly direction: "UP" | "DOWN";
  readonly planned: "WIN" | "LOSS";
  readonly entryPrice: number;
  readonly toReturn: number;
}

/** Messages produced by one or more ticks: some for everyone, some per market. */
class Frame {
  readonly global: DemoMessage[] = [];
  readonly byMarket = new Map<string, DemoMessage[]>();
  readonly byPlayer = new Map<string, DemoMessage[]>();

  constructor(private readonly watched: ReadonlySet<string>) {}

  /** The list to append this market's messages to, or null when nobody is watching it. */
  forMarket(id: string): DemoMessage[] | null {
    if (!this.watched.has(id)) return null;
    let list = this.byMarket.get(id);
    if (!list) this.byMarket.set(id, (list = []));
    return list;
  }

  /** Messages only this player should see — their own trades and wallet. */
  forPlayer(id: string): DemoMessage[] {
    let list = this.byPlayer.get(id);
    if (!list) this.byPlayer.set(id, (list = []));
    return list;
  }
}

/** One market: its engine, closed candles and open trades. */
class MarketSim {
  readonly registry: AssetRegistry;
  readonly params: PriceParams;
  readonly closed = new Map<Timeframe, Candle[]>();
  open: LiveTrade[] = [];
  /** The last SHOWN price, rounded — what the chart drew. */
  lastPrice: number;

  constructor(
    readonly market: GameMarket,
    seed: number,
    settings: Settings,
  ) {
    this.params = marketParams(market, settings.model, settings.persistence);
    this.registry = new AssetRegistry(seed);
    this.registry.add({
      symbol: market.id,
      kind: "OTC",
      precision: market.precision,
      basePrice: market.basePrice,
      params: this.params,
    });
    this.lastPrice = market.basePrice;
  }

  get asset(): LiveAsset {
    return this.registry.all()[0]!;
  }

  /**
   * Advance one tick. Chart messages go to `out` (skipped when null — nobody
   * is watching, or history is being generated); expired trades go to `settled`.
   */
  step(simSec: number, out: DemoMessage[] | null, settled: SettledTradeView[]): void {
    const { market, registry } = this;
    const asset = this.asset;

    // sigmaTick is read from the pre-tick volatility state — the same
    // conditional volatility stepPrice is about to use — so the magnet cap
    // scales to the move that's actually about to happen.
    const sigmaTick = perTickSigma(registry.sigmaNow(market.id, simSec), STAMP_SEC);
    const magnet =
      this.open.length === 0
        ? 0
        : blendedMagnet({ trades: this.open, currentPrice: asset.state.price, nowSec: simSec, sigmaTick });

    const res = registry.tick(market.id, { driftBias: 0, magnet }, { nowSec: simSec, dtSec: STAMP_SEC });

    // Commit-phase snap AFTER stepPrice — in the last COMMIT_WINDOW_SEC of a
    // stamped trade this pins the shown price toward target so no z draw can
    // pull the chart back across the target line in the final ticks.
    const snapped =
      this.open.length === 0
        ? res.price
        : commitSnap({ shownPrice: res.price, trades: this.open, nowSec: simSec, tickSize: market.tickSize });
    if (snapped !== res.price) asset.state = { ...asset.state, price: snapped };
    const shownPrice = +snapped.toFixed(market.precision);

    // Build the candle from the FINAL shown price — the one the client sees on
    // this tick — so no closed bar carries a point the live chart did not draw.
    // Closes go out BEFORE the tick that caused them: the tick already belongs
    // to the next bucket, and the chart rejects an update older than its last bar.
    for (const { timeframe, candle } of registry.record(market.id, simSec, shownPrice)) {
      const list = this.closed.get(timeframe) ?? [];
      list.push(candle);
      if (list.length > MAX_KEPT) list.shift();
      this.closed.set(timeframe, list);
      out?.push({ type: "candle:close", symbol: market.id, timeframe, candle });
    }
    if (out) {
      out.push({ type: "tick", symbol: market.id, price: shownPrice, ts: simSec });
      out.push({
        type: "detail",
        symbol: market.id,
        ts: simSec,
        z: res.z,
        volMultiple: res.sigma / longRunSigma(this.params),
        intraday: this.params.intraday ? intradayFactor(this.params.intraday, simSec) : 1,
        layers: asset.vol?.layers ?? null,
        news: asset.news,
        momentum: asset.state.momentum,
        steer: sigmaTick > 0 ? magnet / sigmaTick : 0,
        snap: snapped - res.price,
        prevPrice: this.lastPrice,
        price: shownPrice,
      });
    }

    // Settle expired trades at this tick's shown price. The result is whatever
    // the chart shows: the steering usually lands it on the planned side, but a
    // target the snap budget can't reach settles honestly — that's informative.
    if (this.open.length > 0) {
      const stillOpen: LiveTrade[] = [];
      for (const t of this.open) {
        if (simSec < t.expirySec) {
          stillOpen.push(t);
          continue;
        }
        // A tie — the price landing exactly on entry — is common on markets
        // with a coarse tick, so it refunds rather than counting as a loss.
        const outcome: Outcome =
          shownPrice === t.entryPrice
            ? "TIE"
            : (shownPrice > t.entryPrice) === (t.direction === "UP")
              ? "WIN"
              : "LOSS";
        settled.push({ ...toView(t), exitPrice: shownPrice, outcome, credited: 0 });
      }
      this.open = stillOpen;
    }

    this.lastPrice = shownPrice;
  }

  quote(simSec: number): Quote {
    // Open of the first 1m candle inside the last 24 chart hours.
    const bars = this.closed.get("1m") ?? [];
    const from = simSec - DAY_SEC;
    let lo = 0;
    let hi = bars.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid]!.openTs < from) lo = mid + 1;
      else hi = mid;
    }
    const ref = bars[lo]?.o ?? this.market.basePrice;
    return { id: this.market.id, price: this.lastPrice, changePct: (100 * (this.lastPrice - ref)) / ref };
  }
}

class Simulation {
  private sims = new Map<string, MarketSim>();
  private simSec = 0;
  private timer: NodeJS.Timeout | null = null;
  private settled: SettledTradeView[] = [];
  private tradeSeq = 0;
  private tradeRng: () => number = Math.random;
  // The user can slide persistence anywhere between 0 and MAX_PERSISTENCE_SEC
  // from the page controls.
  settings: Settings = {
    model: "msm",
    speed: 10,
    persistence: DEFAULT_PERSISTENCE.msm,
    paused: false,
    winRate: null,
    payoutRate: DEFAULT_ECONOMY.payoutRate,
    stakes: STAKES,
  };
  /**
   * The hamoud ledger. Survives chart rebuilds — restarting the markets must
   * not wipe anyone's balance — and runs on the GAME clock, so "Skip ahead"
   * rolls the day over and the daily top-up comes round again.
   */
  readonly economy = new Economy(Math.floor(Date.now() / 1000), DEFAULT_ECONOMY);

  constructor(
    private readonly emit: (frame: Frame) => void,
    private readonly watched: () => ReadonlySet<string>,
  ) {
    this.restart();
  }

  /** Rebuild every market from the seed — same seed + same settings = the same charts. */
  restart(): void {
    this.sims = new Map(
      GAME_MARKETS.map((m, i) => [m.id, new MarketSim(m, SEED * 1000 + i, this.settings)]),
    );
    this.settled = [];
    // History ends at the current wall-clock minute, then the live part runs on.
    this.simSec = Math.floor(Date.now() / 1000 / 60) * 60 - HISTORY_MINUTES * 60;
    this.advance((HISTORY_MINUTES * 60) / STAMP_SEC);
    this.schedule();
  }

  /** This player's own open and settled trades. */
  tradesSnapshot(playerId: string): DemoMessage {
    return {
      type: "trades:snapshot",
      open: [...this.sims.values()].flatMap((s) =>
        s.open.filter((t) => t.playerId === playerId).map(toView),
      ),
      settled: this.settled.filter((t) => t.player === playerId),
    };
  }

  wallet(playerId: string): Wallet {
    const account = this.economy.account(playerId);
    return {
      type: "wallet",
      playerId,
      balance: account.balance,
      canClaim: this.economy.canClaim(playerId),
      nextRewardSec: this.economy.secondsToNextReward(this.simSec),
      dailyReward: this.economy.config.dailyReward,
      stakedToday: account.stakedToday,
      netToday: account.netToday,
      tradesToday: account.tradesToday,
      winsToday: account.winsToday,
    };
  }

  economyMessage(): DemoMessage {
    return {
      type: "economy",
      stats: this.economy.stats(),
      breakEven: breakEvenWinRate(this.economy.config),
    };
  }

  /** Hand out the daily top-up. Returns how much was added. */
  claim(playerId: string): number {
    this.economy.tick(this.simSec);
    return this.economy.claimDailyReward(playerId);
  }

  quotes(): DemoMessage {
    return { type: "quotes", quotes: [...this.sims.values()].map((s) => s.quote(this.simSec)) };
  }

  openTrade(
    playerId: string,
    marketId: string,
    direction: "UP" | "DOWN",
    durationSec: number,
    stake: number,
  ): string | null {
    const sim = this.sims.get(marketId);
    if (!sim) return "unknown market";
    if (!TRADE_DURATIONS_SEC.includes(durationSec as (typeof TRADE_DURATIONS_SEC)[number])) {
      return `durationSec must be one of ${TRADE_DURATIONS_SEC}`;
    }
    if (!STAKES.includes(stake)) return `stake must be one of ${STAKES}`;
    if (!this.economy.placeStake(playerId, stake)) return "not enough hamoud";
    const { market } = sim;
    const entryPrice = sim.lastPrice;
    // The game picks the result now: WIN places the target on the player's side
    // (the magnet drags the chart in their favour); LOSS places it on the
    // opposite side. From the engine's point of view both are stamped
    // non-HONEST trades — the magnet just pulls toward the target.
    //
    // The win rate comes from the economy controller, which is reading the
    // day's ledger and steering the hamoud supply (src/economy.ts). The
    // demo override replaces it with a fixed number.
    const winRate = this.settings.winRate ?? this.economy.winRateFor(playerId);
    const planned = this.tradeRng() < winRate ? "WIN" : "LOSS";
    const sigma = sim.registry.sigmaNow(market.id, this.simSec);
    const offset = Math.max(market.tickSize, TARGET_SIGMAS * entryPrice * sigma * Math.sqrt(durationSec));
    const towardWin = direction === "UP" ? offset : -offset;
    const targetPrice = +(entryPrice + (planned === "WIN" ? towardWin : -towardWin)).toFixed(market.precision);
    if (targetPrice <= 0) return "target would be non-positive";
    const trade: LiveTrade = {
      id: `t${++this.tradeSeq}`,
      market: market.id,
      playerId,
      direction,
      planned,
      entryPrice,
      toReturn: stake * (1 + this.economy.config.payoutRate),
      verdict: "WIN",
      pathStyle: pickStyle(durationSec, this.tradeRng),
      targetPrice,
      entrySec: this.simSec,
      expirySec: this.simSec + durationSec,
      stake,
    };
    sim.open.push(trade);
    const frame = new Frame(new Set());
    frame.forPlayer(playerId).push({ type: "trade:open", trade: toView(trade) });
    this.emit(frame);
    return null;
  }

  /** Run `count` ticks with no streaming — used for history and Skip. */
  advance(count: number): void {
    for (let i = 0; i < count; i++) this.step(null);
  }

  history(marketId: string, timeframe: Timeframe): ServerMessage | null {
    const sim = this.sims.get(marketId);
    if (!sim) return null;
    const forming = sim.registry.formingCandle(marketId, timeframe);
    return {
      type: "candles:history",
      symbol: marketId,
      timeframe,
      candles: sim.closed.get(timeframe) ?? [],
      ...(forming ? { forming } : {}),
    };
  }

  update(next: Partial<Settings>): void {
    // Switching model brings that model's own default momentum with it.
    if (next.model !== undefined && next.model !== this.settings.model && next.persistence === undefined) {
      next = { ...next, persistence: DEFAULT_PERSISTENCE[next.model] };
    }
    const needsRestart =
      (next.persistence !== undefined && next.persistence !== this.settings.persistence) ||
      (next.model !== undefined && next.model !== this.settings.model);
    this.settings = { ...this.settings, ...next };
    if (needsRestart) this.restart();
    else this.schedule();
  }

  /** One tick, streamed. Works while paused — that's the Step button. */
  stepLive(): void {
    const frame = new Frame(this.watched());
    this.step(frame);
    this.emit(frame);
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.settings.paused) return;
    const ticksPerFrame = Math.max(1, Math.ceil(this.settings.speed / STAMP_SEC / MAX_FRAMES_PER_SEC));
    const frameMs = (1000 * ticksPerFrame * STAMP_SEC) / this.settings.speed;
    const run = (): void => {
      const frame = new Frame(this.watched());
      for (let i = 0; i < ticksPerFrame; i++) this.step(frame);
      this.emit(frame);
      this.timer = setTimeout(run, frameMs);
    };
    this.timer = setTimeout(run, frameMs);
  }

  private step(frame: Frame | null): void {
    this.simSec += STAMP_SEC;
    // Rolling into a new game day resets the ledger's daily counters and
    // makes the top-up available again.
    this.economy.tick(this.simSec);
    const settled: SettledTradeView[] = [];
    for (const sim of this.sims.values()) {
      sim.step(this.simSec, frame?.forMarket(sim.market.id) ?? null, settled);
    }
    for (const trade of settled) {
      const credited = this.economy.settle(trade.player, trade.stake, trade.outcome);
      const paid = { ...trade, credited };
      this.settled.unshift(paid);
      if (this.settled.length > MAX_SETTLED_KEPT) this.settled.pop();
      frame?.forPlayer(trade.player)?.push({ type: "trade:settle", trade: paid });
    }
  }
}

function toView(t: LiveTrade): TradeView {
  return {
    id: t.id,
    market: t.market,
    player: t.playerId,
    direction: t.direction,
    toReturn: t.toReturn,
    planned: t.planned,
    pathStyle: t.pathStyle!,
    entryPrice: t.entryPrice,
    targetPrice: t.targetPrice,
    entrySec: t.entrySec,
    expirySec: t.expirySec,
    stake: t.stake,
  };
}

const MARKETS: MarketInfo[] = GAME_MARKETS.map((m) => ({
  id: m.id,
  name: m.name,
  subtitle: m.subtitle,
  group: m.group,
  badge: m.badge,
  color: m.color,
  precision: m.precision,
  tickSize: m.tickSize,
  unit: m.unit,
}));
// Every market shares the same MSM layer timescales.
const LAYER_SECS = msmDurations(marketMsm(GAME_MARKETS[0]!));

/** Open event streams, each with the market it watches and the player behind it. */
interface Client {
  market: string;
  readonly playerId: string;
}
const clients = new Map<ServerResponse, Client>();
const send = (res: ServerResponse, frame: DemoMessage[]): void => {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
};
const broadcast = (frame: DemoMessage[]): void => {
  for (const res of clients.keys()) send(res, frame);
};
const deliver = (frame: Frame): void => {
  for (const [res, client] of clients) {
    const messages = [
      ...(frame.byMarket.get(client.market) ?? []),
      ...(frame.byPlayer.get(client.playerId) ?? []),
      ...frame.global,
    ];
    if (messages.length > 0) send(res, messages);
  }
};
/** Wallets are per player, so each stream gets its own copy. */
const broadcastWallets = (extra: DemoMessage[]): void => {
  for (const [res, client] of clients) send(res, [...extra, sim.wallet(client.playerId)]);
};
/** After a rebuild: everyone reloads, and each player gets their own trades. */
const broadcastSnapshots = (): void => {
  for (const [res, client] of clients) {
    send(res, [
      { type: "reset" },
      sim.tradesSnapshot(client.playerId),
      sim.quotes(),
      sim.wallet(client.playerId),
    ]);
  }
};
const settingsMessage = (): DemoMessage => ({
  type: "settings",
  settings: sim.settings,
  stampSec: STAMP_SEC,
  layerSecs: LAYER_SECS,
});

const startedAt = Date.now();
const sim = new Simulation(deliver, () => new Set([...clients.values()].map((c) => c.market)));
console.log(
  `generated ${HISTORY_MINUTES / 60}h of history for ${GAME_MARKETS.length} markets in ${Date.now() - startedAt}ms`,
);
setInterval(() => {
  if (clients.size > 0) broadcastWallets([sim.quotes(), sim.economyMessage()]);
}, QUOTES_EVERY_MS);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const parsed: unknown = JSON.parse(body || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function handleControl(cmd: Record<string, unknown>, playerId: string): string | null {
  switch (cmd.action) {
    case "pause":
      sim.update({ paused: true });
      break;
    case "resume":
      sim.update({ paused: false });
      break;
    case "step":
      sim.stepLive();
      break;
    case "restart":
      sim.restart();
      broadcastSnapshots();
      break;
    case "skip": {
      const minutes = Number(cmd.minutes);
      if (!(minutes > 0 && minutes <= 24 * 60)) return "minutes must be between 1 and 1440";
      sim.advance((minutes * 60) / STAMP_SEC);
      broadcastSnapshots();
      break;
    }
    case "speed": {
      const speed = Number(cmd.value);
      if (!(SPEEDS as readonly number[]).includes(speed)) return `speed must be one of ${SPEEDS}`;
      sim.update({ speed });
      break;
    }
    case "persistence": {
      const persistence = Number(cmd.value);
      if (!(persistence >= 0 && persistence <= MAX_PERSISTENCE_SEC)) {
        return `persistence must be between 0 and ${MAX_PERSISTENCE_SEC}`;
      }
      sim.update({ persistence });
      broadcastSnapshots();
      break;
    }
    case "model": {
      const model = cmd.value;
      if (model !== "msm" && model !== "garch") return "model must be msm or garch";
      sim.update({ model });
      broadcastSnapshots();
      break;
    }
    case "trade": {
      const direction = cmd.direction;
      if (direction !== "UP" && direction !== "DOWN") return "direction must be UP or DOWN";
      const error = sim.openTrade(
        playerId,
        String(cmd.market),
        direction,
        Number(cmd.durationSec),
        Number(cmd.stake),
      );
      // Settings didn't change; the wallet did.
      if (!error) broadcastWallets([]);
      return error;
    }
    case "claim": {
      sim.claim(playerId);
      broadcastWallets([]);
      return null;
    }
    case "winRate": {
      const raw = cmd.value;
      const winRate = raw === "auto" || raw === null ? null : Number(raw);
      if (winRate !== null && !(WIN_RATE_OPTIONS as readonly number[]).includes(winRate)) {
        return `winRate must be "auto" or one of ${WIN_RATE_OPTIONS}`;
      }
      sim.update({ winRate });
      break;
    }
    default:
      return "unknown action";
  }
  broadcast([settingsMessage()]);
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(join(HERE, "index.html")));
      return;
    }
    if (req.method === "GET" && url.pathname === "/client.js") {
      // Bundled on every request so edits to client.ts show up on reload.
      const result = await build({
        entryPoints: [join(HERE, "client.ts")],
        bundle: true,
        write: false,
        format: "esm",
        target: "es2020",
        sourcemap: "inline",
      });
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(result.outputFiles[0]!.text);
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      // An unknown market still gets the stream — the page falls back to a
      // real one once it sees the market list.
      const market = url.searchParams.get("market") ?? "";
      const playerId = url.searchParams.get("player") || `anon-${Math.random().toString(36).slice(2)}`;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.set(res, { market, playerId });
      send(res, [
        settingsMessage(),
        { type: "markets", markets: MARKETS },
        sim.quotes(),
        sim.economyMessage(),
        sim.wallet(playerId),
        sim.tradesSnapshot(playerId),
      ]);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/history") {
      const tf = url.searchParams.get("tf") as Timeframe;
      if (!(tf in TIMEFRAME_SEC)) {
        res.writeHead(400).end("unknown timeframe");
        return;
      }
      const history = sim.history(url.searchParams.get("market") ?? "", tf);
      if (!history) {
        res.writeHead(400).end("unknown market");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(history));
      return;
    }
    if (req.method === "POST" && url.pathname === "/control") {
      const body = await readJson(req);
      const error = handleControl(body, String(body.player ?? ""));
      res.writeHead(error ? 400 : 204).end(error ?? undefined);
      return;
    }
    res.writeHead(404).end("not found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end(String(err));
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(
    `Port ${PORT} is already in use — the demo is probably already running at http://localhost:${PORT}.\n` +
      `Stop that one first, or use another port: PORT=${PORT + 1} npm run live`,
  );
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`market game demo → http://localhost:${PORT}  (seed ${SEED}, all markets simulated)`);
});

