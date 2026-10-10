// Live demo server. Runs the same AssetRegistry tick → record pipeline the
// engine uses and streams it to the browser over Server-Sent Events in the real
// platform's message shapes (`candles:history`, `candle:close`, `tick`). The
// page folds those with applyChartMessage — the web app's own client fold —
// and paints them with lightweight-charts.
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
  perTickSigma,
  pickStyle,
  TICK_DT_SEC,
  TIMEFRAME_SEC,
  type Candle,
  type PathStyle,
  type ServerMessage,
  type StampedTrade,
  type Timeframe,
} from "../src/index";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 5180);
const SEED = Number(process.env.SEED ?? 42);
const SYMBOL = "AUDNZD_OTC";
const BASE_PRICE = 1.175;
const GARCH = { omega: 1e-10, alpha: 0.08, beta: 0.9 };
// Chart seconds between ticks. 1 matches example-fast, so a 1m candle is built
// from 60 ticks — each still carrying TICK_DT_SEC of volatility.
const STAMP_SEC = 1;
const HISTORY_MINUTES = 60;
const MAX_KEPT = 5000;
const SPEEDS = [1, 10, 60, 300] as const;
// Upper bound for trendPersistenceSec set from the page. Well past the point
// where 1m candles lose their wicks entirely.
const MAX_PERSISTENCE_SEC = 600;
// Browsers can't usefully take more than ~60 frames a second; above that,
// several ticks share one frame.
const MAX_FRAMES_PER_SEC = 60;
// Trade targets are placed this many price units above entry (for UP) or below
// (for DOWN). 5 pips at AUDNZD precision — comfortably inside stepPrice's
// maxTickMove backstop so the magnet can always pull toward it.
const TARGET_OFFSET = 0.0005;
// AUDNZD tick size (1 pip at precision 5). commitSnap now uses this × 10 as
// its visual budget.
const TICK_SIZE = 0.00001;
const MAX_TICK_MOVE = 0.002;
const TRADE_DURATIONS_SEC = [30, 60, 120] as const;
const STAKE_PAISE = 100_00; // ₹100
const PAYOUT_PCT = 85;
const MAX_SETTLED_KEPT = 20;

export interface Settings {
  readonly speed: number;
  readonly persistence: number;
  readonly paused: boolean;
  /** Probability a new trade is WIN-stamped (target placed on the user's side). */
  readonly winRate: number;
}

const WIN_RATE_OPTIONS = [0.25, 0.5, 1.0] as const;

/** Everything the page needs to explain one tick. */
export interface TickDetail {
  readonly type: "detail";
  readonly ts: number;
  readonly z: number;
  /** GARCH volatility as a multiple of its long-run level. */
  readonly volMultiple: number;
  readonly momentum: number;
  readonly prevPrice: number;
  readonly price: number;
}

/** A UI-friendly view of an open or settled trade. */
export interface TradeView {
  readonly id: string;
  readonly direction: "UP" | "DOWN";
  readonly pathStyle: PathStyle;
  readonly entryPrice: number;
  readonly targetPrice: number;
  readonly entrySec: number;
  readonly expirySec: number;
  readonly stake: number;
  readonly payoutPct: number;
}

export interface SettledTradeView extends TradeView {
  readonly exitPrice: number;
  readonly outcome: "WIN" | "LOSS";
  /** PnL in paise. +stake·payoutPct/100 on WIN, -stake on LOSS. */
  readonly pnl: number;
}

export type DemoMessage =
  | ServerMessage
  | TickDetail
  | { type: "settings"; settings: Settings; stampSec: number; tickDtSec: number }
  | { type: "reset" }
  | { type: "trades:snapshot"; open: TradeView[]; settled: SettledTradeView[] }
  | { type: "trade:open"; trade: TradeView }
  | { type: "trade:settle"; trade: SettledTradeView };

interface LiveTrade extends StampedTrade {
  readonly id: string;
  readonly direction: "UP" | "DOWN";
  readonly entryPrice: number;
}

class Simulation {
  private registry!: AssetRegistry;
  private closed = new Map<Timeframe, Candle[]>();
  private simSec = 0;
  private lastPrice = BASE_PRICE;
  private timer: NodeJS.Timeout | null = null;
  private readonly longRunSigma = Math.sqrt(GARCH.omega / (1 - GARCH.alpha - GARCH.beta));
  private open: LiveTrade[] = [];
  private settled: SettledTradeView[] = [];
  private tradeSeq = 0;
  private tradeRng: () => number = Math.random;
  // persistence: 10 is chosen for ~70% body / ~30% wick. The user can still
  // slide it anywhere between 0 and MAX_PERSISTENCE_SEC from the page controls.
  settings: Settings = { speed: 10, persistence: 10, paused: false, winRate: 0.5 };

  constructor(private readonly emit: (frame: DemoMessage[]) => void) {
    this.restart();
  }

  /** Rebuild from the seed — same seed + same settings = the same chart. */
  restart(): void {
    this.registry = new AssetRegistry(SEED);
    this.registry.add({
      symbol: SYMBOL,
      kind: "OTC",
      precision: 5,
      basePrice: BASE_PRICE,
      params: {
        garch: GARCH,
        driftPerSec: 0,
        anchorAlpha: 0,
        maxTickMove: MAX_TICK_MOVE,
        trendPersistenceSec: this.settings.persistence,
      },
    });
    this.closed = new Map();
    this.lastPrice = BASE_PRICE;
    this.open = [];
    this.settled = [];
    // History ends at the current wall-clock minute, then the live part runs on.
    this.simSec = Math.floor(Date.now() / 1000 / 60) * 60 - HISTORY_MINUTES * 60;
    this.advance((HISTORY_MINUTES * 60) / STAMP_SEC);
    this.schedule();
  }

  tradesSnapshot(): DemoMessage {
    return {
      type: "trades:snapshot",
      open: this.open.map(toView),
      settled: this.settled,
    };
  }

  openTrade(direction: "UP" | "DOWN", durationSec: number): string | null {
    if (!TRADE_DURATIONS_SEC.includes(durationSec as (typeof TRADE_DURATIONS_SEC)[number])) {
      return `durationSec must be one of ${TRADE_DURATIONS_SEC}`;
    }
    const asset = this.registry.all()[0]!;
    const entryPrice = +asset.state.price.toFixed(5);
    // Flip at open: WIN places the target on the user's side (the magnet drags
    // the chart in their favor); LOSS places it on the opposite side (the
    // magnet drags against them). From the live engine's POV it's still a
    // stamped non-HONEST trade — the magnet function doesn't care which side
    // the target is on, it just pulls toward it.
    const willWin = this.tradeRng() < this.settings.winRate;
    const favorableOffset = direction === "UP" ? +TARGET_OFFSET : -TARGET_OFFSET;
    const targetRaw = entryPrice + (willWin ? favorableOffset : -favorableOffset);
    const targetPrice = +targetRaw.toFixed(5);
    if (targetPrice <= 0) return "target would be non-positive";
    const pathStyle = pickStyle(durationSec, this.tradeRng);
    const trade: LiveTrade = {
      id: `t${++this.tradeSeq}`,
      direction,
      entryPrice,
      verdict: "WIN",
      pathStyle,
      targetPrice,
      entrySec: this.simSec,
      expirySec: this.simSec + durationSec,
      stake: STAKE_PAISE,
      payoutPct: PAYOUT_PCT,
    };
    this.open.push(trade);
    this.emit([{ type: "trade:open", trade: toView(trade) }]);
    return null;
  }

  /** Run `count` ticks with no streaming — used for history and Skip. */
  advance(count: number): void {
    for (let i = 0; i < count; i++) this.step();
  }

  history(timeframe: Timeframe): ServerMessage {
    const forming = this.registry.formingCandle(SYMBOL, timeframe);
    return {
      type: "candles:history",
      symbol: SYMBOL,
      timeframe,
      candles: this.closed.get(timeframe) ?? [],
      ...(forming ? { forming } : {}),
    };
  }

  update(next: Partial<Settings>): void {
    const needsRestart =
      next.persistence !== undefined && next.persistence !== this.settings.persistence;
    this.settings = { ...this.settings, ...next };
    if (needsRestart) this.restart();
    else this.schedule();
  }

  /** One tick, streamed. Works while paused — that's the Step button. */
  stepLive(): void {
    this.emit(this.step());
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.settings.paused) return;
    const ticksPerFrame = Math.max(1, Math.ceil(this.settings.speed / STAMP_SEC / MAX_FRAMES_PER_SEC));
    const frameMs = (1000 * ticksPerFrame * STAMP_SEC) / this.settings.speed;
    const run = (): void => {
      const frame: DemoMessage[] = [];
      for (let i = 0; i < ticksPerFrame; i++) frame.push(...this.step());
      this.emit(frame);
      this.timer = setTimeout(run, frameMs);
    };
    this.timer = setTimeout(run, frameMs);
  }

  private step(): DemoMessage[] {
    this.simSec += STAMP_SEC;
    const asset = this.registry.all()[0]!;

    // sigmaTick is read from the pre-tick GARCH state — the same conditional
    // volatility stepPrice is about to use — so the magnet cap scales to the
    // move that's actually about to happen.
    const sigma = Math.sqrt(asset.state.garch.sigma2);
    const sigmaTick = perTickSigma(sigma, TICK_DT_SEC);

    const magnet = blendedMagnet({
      trades: this.open,
      currentPrice: asset.state.price,
      nowSec: this.simSec,
      sigmaTick,
    });

    const out = this.registry.tick(SYMBOL, { driftBias: 0, magnet });

    // Commit-phase snap AFTER stepPrice — in the last COMMIT_WINDOW_SEC of a
    // stamped trade this pins the shown price toward target so no z draw can
    // pull the chart back across the target line in the final ticks.
    const snapped = commitSnap({
      shownPrice: out.price,
      trades: this.open,
      nowSec: this.simSec,
      tickSize: TICK_SIZE,
    });
    if (snapped !== out.price) {
      asset.state = { ...asset.state, price: snapped };
    }
    const shownPrice = +snapped.toFixed(5);

    // Build the candle from the FINAL shown price — the one the client sees on
    // this tick — so no closed bar carries a point the live chart did not draw.
    const closed = this.registry.record(SYMBOL, this.simSec, shownPrice);
    const frame: DemoMessage[] = [];

    // Closes go out BEFORE the tick that caused them. The tick already belongs
    // to the next bucket; sending it first would make the chart draw the new
    // bar and then be handed an older one to update, which it rejects.
    for (const { timeframe, candle } of closed) {
      const list = this.closed.get(timeframe) ?? [];
      list.push(candle);
      if (list.length > MAX_KEPT) list.shift();
      this.closed.set(timeframe, list);
      frame.push({ type: "candle:close", symbol: SYMBOL, timeframe, candle });
    }
    frame.push({ type: "tick", symbol: SYMBOL, price: shownPrice, ts: this.simSec });
    frame.push({
      type: "detail",
      ts: this.simSec,
      z: out.z,
      volMultiple: out.sigma / this.longRunSigma,
      momentum: asset.state.momentum,
      prevPrice: this.lastPrice,
      price: shownPrice,
    });

    // Settle any expired trades at this tick's shown price. The verdict is
    // always WIN here (the demo exists to show the magnet works) so the WIN /
    // LOSS outcome below is "did the magnet actually land it on the right side
    // of entry". If a target is clipped by maxTickMove inside the commit
    // window, LOSS is possible — that's informative.
    const stillOpen: LiveTrade[] = [];
    for (const t of this.open) {
      if (this.simSec < t.expirySec) {
        stillOpen.push(t);
        continue;
      }
      const won =
        t.direction === "UP" ? shownPrice > t.entryPrice : shownPrice < t.entryPrice;
      const pnl = won ? Math.round((t.stake * t.payoutPct) / 100) : -t.stake;
      const settled: SettledTradeView = {
        ...toView(t),
        exitPrice: shownPrice,
        outcome: won ? "WIN" : "LOSS",
        pnl,
      };
      this.settled.unshift(settled);
      if (this.settled.length > MAX_SETTLED_KEPT) this.settled.pop();
      frame.push({ type: "trade:settle", trade: settled });
    }
    this.open = stillOpen;

    this.lastPrice = shownPrice;
    return frame;
  }
}

function toView(t: LiveTrade): TradeView {
  return {
    id: t.id,
    direction: t.direction,
    pathStyle: t.pathStyle!,
    entryPrice: t.entryPrice,
    targetPrice: t.targetPrice,
    entrySec: t.entrySec,
    expirySec: t.expirySec,
    stake: t.stake,
    payoutPct: t.payoutPct,
  };
}

const clients = new Set<ServerResponse>();
const send = (res: ServerResponse, frame: DemoMessage[]): void => {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
};
const broadcast = (frame: DemoMessage[]): void => {
  for (const res of clients) send(res, frame);
};
const settingsMessage = (): DemoMessage => ({
  type: "settings",
  settings: sim.settings,
  stampSec: STAMP_SEC,
  tickDtSec: TICK_DT_SEC,
});

const sim = new Simulation(broadcast);

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

function handleControl(cmd: Record<string, unknown>): string | null {
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
      broadcast([{ type: "reset" }, sim.tradesSnapshot()]);
      break;
    case "skip": {
      const minutes = Number(cmd.minutes);
      if (!(minutes > 0 && minutes <= 24 * 60)) return "minutes must be between 1 and 1440";
      sim.advance((minutes * 60) / STAMP_SEC);
      broadcast([{ type: "reset" }, sim.tradesSnapshot()]);
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
      broadcast([{ type: "reset" }, sim.tradesSnapshot()]);
      break;
    }
    case "trade": {
      const direction = cmd.direction;
      if (direction !== "UP" && direction !== "DOWN") return "direction must be UP or DOWN";
      const durationSec = Number(cmd.durationSec);
      const error = sim.openTrade(direction, durationSec);
      if (error) return error;
      // Settings didn't change, so skip the trailing broadcast.
      return null;
    }
    case "winRate": {
      const winRate = Number(cmd.value);
      if (!(WIN_RATE_OPTIONS as readonly number[]).includes(winRate)) {
        return `winRate must be one of ${WIN_RATE_OPTIONS}`;
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
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      clients.add(res);
      send(res, [settingsMessage(), sim.tradesSnapshot()]);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "GET" && url.pathname === "/history") {
      const tf = url.searchParams.get("tf") as Timeframe;
      if (!(tf in TIMEFRAME_SEC)) {
        res.writeHead(400).end("unknown timeframe");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sim.history(tf)));
      return;
    }
    if (req.method === "POST" && url.pathname === "/control") {
      const error = handleControl(await readJson(req));
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
  console.log(`candle live demo → http://localhost:${PORT}  (seed ${SEED})`);
});
