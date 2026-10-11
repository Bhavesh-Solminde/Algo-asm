// Browser side of the game demo. Streams frames for the selected market from
// /events, folds the platform messages with applyChartMessage (the web app's
// own client fold), paints the result with lightweight-charts, and explains
// the latest tick in the side panel. Every market is fictional and every price
// simulated — the page shows a notice saying so before anything else.

import {
  CandlestickSeries,
  CrosshairMode,
  createChart,
  createTextWatermark,
  LineStyle,
  type CandlestickData,
  type IPriceLine,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../src/candles";
import {
  applyChartMessage,
  initialChartState,
  TIMEFRAME_SEC,
  type ChartState,
} from "../src/client-fold";
import type { Timeframe } from "../src/engine-loop";
import type {
  DemoMessage,
  MarketInfo,
  Quote,
  SettledTradeView,
  Settings,
  TickDetail,
  TradeView,
  Wallet,
} from "./server";
import type { EconomyStats } from "../src/economy";

const DEFAULT_MARKET = "BOT-BUKT";
const SPARK_POINTS = 240;
const LOG_LINES = 40;
const NOTICE_KEY = "market-sim-notice-ack";
const PLAYER_KEY = "market-sim-player";

/**
 * This browser's player id. Hamoud balances hang off it, so it is kept in
 * localStorage — clear it and you are a new player with an empty purse.
 */
const playerId = ((): string => {
  try {
    const saved = localStorage.getItem(PLAYER_KEY);
    if (saved) return saved;
    const made = `p-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(PLAYER_KEY, made);
    return made;
  } catch {
    return `p-${Math.random().toString(36).slice(2, 10)}`;
  }
})();

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

// ---- notice screen ---------------------------------------------------------

const notice = $("#notice");
function showNotice(): void {
  notice.hidden = false;
  $<HTMLButtonElement>("#notice-ok").focus();
}
$("#notice-ok").addEventListener("click", () => {
  notice.hidden = true;
  try {
    sessionStorage.setItem(NOTICE_KEY, "1");
  } catch {
    // Storage blocked — the notice simply shows again next load.
  }
});
$("#notice-open").addEventListener("click", showNotice);
let acknowledged = false;
try {
  acknowledged = sessionStorage.getItem(NOTICE_KEY) === "1";
} catch {
  acknowledged = false;
}
if (!acknowledged) showNotice();

// ---- chart -------------------------------------------------------------

const chart = createChart($<HTMLElement>("#chart"), {
  autoSize: true,
  layout: { background: { color: "#0b0e14" }, textColor: "#8a93a4", fontSize: 11 },
  grid: { vertLines: { color: "#161c27" }, horzLines: { color: "#161c27" } },
  timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6, borderColor: "#222a38" },
  rightPriceScale: { borderColor: "#222a38", scaleMargins: { top: 0.1, bottom: 0.1 } },
  crosshair: { mode: CrosshairMode.Normal },
});
const series = chart.addSeries(CandlestickSeries, {
  upColor: "#26a69a",
  downColor: "#ef5350",
  wickUpColor: "#26a69a",
  wickDownColor: "#ef5350",
  borderVisible: false,
});
// Burned into the chart so a screenshot can't pass for a real market.
const watermark = createTextWatermark(chart.panes()[0]!, {
  horzAlign: "center",
  vertAlign: "center",
  lines: [],
});

const toBar = (c: Candle): CandlestickData<UTCTimestamp> => ({
  time: c.openTs as UTCTimestamp,
  open: c.o,
  high: c.h,
  low: c.l,
  close: c.c,
});

let lastPainted = -Infinity;

function paintAll(): void {
  const bars = [...state.candles];
  if (state.forming) bars.push(state.forming);
  series.setData(bars.map(toBar));
  lastPainted = bars.at(-1)?.openTs ?? -Infinity;
}

/** update() only accepts the newest bar; anything older needs a full repaint. */
function paintBar(c: Candle): void {
  if (c.openTs >= lastPainted) {
    series.update(toBar(c));
    lastPainted = c.openTs;
  } else {
    paintAll();
  }
}

// ---- state -------------------------------------------------------------

let marketId = location.hash.slice(1) || DEFAULT_MARKET;
let timeframe: Timeframe = "1m";
let state: ChartState = initialChartState(marketId, timeframe);
let settings: Settings = {
  model: "msm",
  speed: 10,
  persistence: 4,
  paused: false,
  winRate: null,
  payoutRate: 0.45,
  stakes: [10, 50, 100, 500],
};
let wallet: Wallet | null = null;
let economy: EconomyStats | null = null;
let breakEven = 0.69;
let stampSec = 1;
let layerSecs: number[] = [];
let markets: MarketInfo[] = [];
const quotes = new Map<string, Quote>();
let loading = false;
let buffered: DemoMessage[][] = [];

let lastDetail: TickDetail | null = null;
let lastEffect = "—";
const volHistory: number[] = [];
const logLines: { text: string; close: boolean }[] = [];
let openTrades: TradeView[] = [];
let settledTrades: SettledTradeView[] = [];
const priceLines = new Map<string, IPriceLine[]>();
let showInternals = true;

const market = (id = marketId): MarketInfo | undefined => markets.find((m) => m.id === id);
const fmt = (price: number, id = marketId): string => price.toFixed(market(id)?.precision ?? 5);
const nameOf = (id: string): string => market(id)?.name ?? id;

/** A price change in the market's own unit — pips for currencies, points elsewhere. */
function moveText(diff: number): string {
  const m = market();
  if (!m) return signed(diff, 5);
  const decimals = Math.max(0, m.precision - Math.round(-Math.log10(m.unit.size)));
  return `${signed(diff / m.unit.size, decimals)} ${m.unit.label}`;
}

async function loadHistory(): Promise<void> {
  loading = true;
  buffered = [];
  state = initialChartState(marketId, timeframe);
  const res = await fetch(`/history?market=${encodeURIComponent(marketId)}&tf=${timeframe}`).catch(() => null);
  const msg = res?.ok ? ((await res.json()) as DemoMessage) : null;
  if (msg?.type === "candles:history" && msg.symbol === marketId && msg.timeframe === timeframe) {
    state = applyChartMessage(state, msg);
  }
  paintAll();
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, state.candles.length - 90),
    to: state.candles.length + 6,
  });
  loading = false;
  // Frames that arrived during the fetch. Re-applying is safe: highs/lows are
  // max/min, closes replace by openTs, ticks for closed buckets are ignored.
  const pending = buffered;
  buffered = [];
  for (const frame of pending) handleFrame(frame);
  scheduleRender();
}

// ---- stream ------------------------------------------------------------

let events: EventSource | null = null;

/** Watch a market: one event stream per market, so only its ticks arrive. */
function selectMarket(id: string): void {
  marketId = id;
  if (location.hash.slice(1) !== id) history.replaceState(null, "", `#${id}`);
  volHistory.length = 0;
  lastDetail = null;
  lastEffect = "—";
  events?.close();
  events = new EventSource(
    `/events?market=${encodeURIComponent(id)}&player=${encodeURIComponent(playerId)}`,
  );
  events.onmessage = (e: MessageEvent<string>) => handleFrame(JSON.parse(e.data) as DemoMessage[]);
  events.onerror = () => {
    $("#stats").textContent = "disconnected — is the server running?";
  };
  applyMarketLook();
  resyncPriceLines();
  void loadHistory();
}

function applyMarketLook(): void {
  const m = market();
  if (!m) return;
  series.applyOptions({ priceFormat: { type: "price", precision: m.precision, minMove: m.tickSize } });
  watermark.applyOptions({
    lines: [
      { text: "SIMULATED", color: "rgba(124, 92, 255, 0.16)", fontSize: 56, fontStyle: "bold" },
      { text: `${m.name} · fictional market`, color: "rgba(138, 147, 164, 0.18)", fontSize: 16 },
    ],
  });
  const icon = $("#m-icon");
  icon.textContent = m.badge;
  icon.style.background = m.color;
  $("#m-name").textContent = m.name;
  $("#m-sub").textContent = m.subtitle;
  document.title = `${m.name} · Market Sim Game`;
  renderMarketList();
}

function handleFrame(frame: DemoMessage[]): void {
  if (loading) {
    buffered.push(frame);
    return;
  }
  for (const msg of frame) {
    switch (msg.type) {
      case "settings":
        settings = msg.settings;
        renderStakeOptions(msg.settings.stakes);
        stampSec = msg.stampSec;
        layerSecs = msg.layerSecs;
        renderControls();
        break;
      case "markets":
        markets = msg.markets;
        if (!market()) {
          // Unknown id in the URL — fall back to the default market.
          selectMarket(DEFAULT_MARKET);
          return;
        }
        applyMarketLook();
        break;
      case "quotes":
        for (const q of msg.quotes) quotes.set(q.id, q);
        renderQuotes();
        break;
      case "wallet":
        wallet = msg;
        renderWallet();
        break;
      case "economy":
        economy = msg.stats;
        breakEven = msg.breakEven;
        break;
      case "reset":
        volHistory.length = 0;
        lastDetail = null;
        lastEffect = "—";
        log("— charts rebuilt —", true);
        void loadHistory();
        return;
      case "candle:close": {
        if (msg.symbol !== marketId) break;
        const next = applyChartMessage(state, msg);
        if (next !== state) {
          state = next;
          paintBar(msg.candle);
          log(
            `${msg.timeframe} CLOSED ${hhmm(msg.candle.openTs)}  O ${fmt(msg.candle.o)} H ${fmt(msg.candle.h)} L ${fmt(msg.candle.l)} C ${fmt(msg.candle.c)}`,
            true,
          );
        }
        break;
      }
      case "tick": {
        if (msg.symbol !== marketId) break;
        const before = state.forming;
        state = applyChartMessage(state, msg);
        const after = state.forming;
        if (after) paintBar(after);
        lastEffect = describeEffect(before, after, msg.price);
        break;
      }
      case "detail":
        if (msg.symbol !== marketId) break;
        lastDetail = msg;
        volHistory.push(msg.volMultiple);
        if (volHistory.length > SPARK_POINTS) volHistory.shift();
        if (settings.speed <= 10 || settings.paused) {
          log(
            `${hhmmss(msg.ts)}  z ${signed(msg.z, 2)}  vol ×${msg.volMultiple.toFixed(2)}  → ${fmt(msg.price)} (${moveText(msg.price - msg.prevPrice)})`,
            false,
          );
        }
        break;
      case "trades:snapshot":
        openTrades = msg.open;
        settledTrades = msg.settled;
        resyncPriceLines();
        break;
      case "trade:open":
        openTrades = [...openTrades, msg.trade];
        addPriceLines(msg.trade);
        log(
          `TRADE OPEN  ${nameOf(msg.trade.market)} ${msg.trade.direction}  entry ${fmt(msg.trade.entryPrice, msg.trade.market)}  −${msg.trade.stake} hamoud (wins ${Math.round(msg.trade.toReturn)})` +
            (showInternals ? `  [planned ${msg.trade.planned} · ${msg.trade.pathStyle}]` : ""),
          true,
        );
        break;
      case "trade:settle":
        openTrades = openTrades.filter((t) => t.id !== msg.trade.id);
        settledTrades = [msg.trade, ...settledTrades].slice(0, 20);
        removePriceLines(msg.trade.id);
        log(
          `TRADE ${msg.trade.outcome}  ${nameOf(msg.trade.market)} ${msg.trade.direction}  exit ${fmt(msg.trade.exitPrice, msg.trade.market)}  ${msg.trade.credited > 0 ? `+${Math.round(msg.trade.credited)}` : "−0"} hamoud`,
          true,
        );
        break;
      case "candles:history":
      case "candles:older":
        break;
    }
  }
  scheduleRender();
}

function addPriceLines(trade: TradeView): void {
  if (trade.market !== marketId) return;
  const lines = [
    series.createPriceLine({
      price: trade.entryPrice,
      color: trade.direction === "UP" ? "#26a69a" : "#ef5350",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `${trade.direction} ${trade.id}`,
    }),
  ];
  // Where the game is steering the chart. Hidden when internals are off.
  if (showInternals) {
    lines.push(
      series.createPriceLine({
        price: trade.targetPrice,
        color: "#a58bff",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: `target ${trade.id} · planned ${trade.planned}`,
      }),
    );
  }
  priceLines.set(trade.id, lines);
}

function removePriceLines(id: string): void {
  for (const line of priceLines.get(id) ?? []) series.removePriceLine(line);
  priceLines.delete(id);
}

function resyncPriceLines(): void {
  for (const id of [...priceLines.keys()]) removePriceLines(id);
  for (const t of openTrades) addPriceLines(t);
}

function describeEffect(before: Candle | null, after: Candle | null, price: number): string {
  if (!after) return "Bucket already closed — tick ignored.";
  if (!before || before.openTs !== after.openTs) {
    return `Crossed into a new ${timeframe} bucket → new candle opens at ${fmt(price)}.`;
  }
  if (after.h > before.h) {
    return price === after.c && after.c >= after.o
      ? "New high → the body stretches up (no upper wick while close = high)."
      : "New high → the top of the candle extends.";
  }
  if (after.l < before.l) {
    return price === after.c && after.c <= after.o
      ? "New low → the body stretches down (no lower wick while close = low)."
      : "New low → the bottom of the candle extends.";
  }
  return "Inside the range → only the close moves; whatever it pulls back from stays as wick.";
}

// ---- controls ----------------------------------------------------------

async function control(body: Record<string, unknown>): Promise<void> {
  const res = await fetch("/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, player: playerId }),
  });
  if (!res.ok) log(`control failed: ${await res.text()}`, true);
}

for (const btn of document.querySelectorAll<HTMLButtonElement>("#tf button")) {
  btn.addEventListener("click", () => {
    timeframe = btn.dataset.tf as Timeframe;
    renderControls();
    void loadHistory();
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>("#speed button")) {
  btn.addEventListener("click", () => void control({ action: "speed", value: Number(btn.dataset.speed) }));
}
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-skip]")) {
  btn.addEventListener("click", () => void control({ action: "skip", minutes: Number(btn.dataset.skip) }));
}
for (const btn of document.querySelectorAll<HTMLButtonElement>("#model button")) {
  btn.addEventListener("click", () => void control({ action: "model", value: btn.dataset.model }));
}
$("#pause").addEventListener("click", () => void control({ action: settings.paused ? "resume" : "pause" }));
$("#step").addEventListener("click", () => void control({ action: "step" }));
$("#restart").addEventListener("click", () => void control({ action: "restart" }));

for (const btn of document.querySelectorAll<HTMLButtonElement>(".dir")) {
  btn.addEventListener("click", () => {
    void control({
      action: "trade",
      market: marketId,
      direction: btn.dataset.dir,
      durationSec: Number($<HTMLSelectElement>("#trade-duration").value),
      stake: Number($<HTMLSelectElement>("#trade-stake").value),
    });
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>("#winrate button")) {
  btn.addEventListener("click", () => {
    const raw = btn.dataset.winrate!;
    void control({ action: "winRate", value: raw === "auto" ? "auto" : Number(raw) });
  });
}
$("#claim").addEventListener("click", () => void control({ action: "claim" }));
$<HTMLSelectElement>("#trade-stake").addEventListener("change", () => renderWallet());
$<HTMLInputElement>("#internals").addEventListener("change", (e) => {
  showInternals = (e.target as HTMLInputElement).checked;
  document.body.classList.toggle("hide-internals", !showInternals);
  resyncPriceLines();
  scheduleRender();
});

// Sidebar trendPersistenceSec control. Every change rebuilds the charts from the
// seed, so dragging only previews the number and the rebuild happens on release.
const persistRange = $<HTMLInputElement>("#persist-range");
const persistNum = $<HTMLInputElement>("#persist-num");
function setPersistence(value: number): void {
  const v = Math.round(Math.max(0, Math.min(Number(persistNum.max), value)));
  if (Number.isFinite(v) && v !== settings.persistence) void control({ action: "persistence", value: v });
  else renderControls();
}
persistRange.addEventListener("input", () => (persistNum.value = persistRange.value));
persistRange.addEventListener("change", () => setPersistence(persistRange.valueAsNumber));
persistNum.addEventListener("change", () => setPersistence(persistNum.valueAsNumber));

window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (id && id !== marketId && market(id)) selectMarket(id);
});

function renderControls(): void {
  const press = (sel: string, on: (b: HTMLButtonElement) => boolean): void => {
    for (const b of document.querySelectorAll<HTMLButtonElement>(sel)) b.setAttribute("aria-pressed", String(on(b)));
  };
  press("#tf button", (b) => b.dataset.tf === timeframe);
  press("#speed button", (b) => Number(b.dataset.speed) === settings.speed);
  press("#winrate button", (b) =>
    b.dataset.winrate === "auto"
      ? settings.winRate === null
      : Number(b.dataset.winrate) === settings.winRate,
  );
  press("#model button", (b) => b.dataset.model === settings.model);
  $("#pause").textContent = settings.paused ? "Resume" : "Pause";
  $("#pause").setAttribute("aria-pressed", String(settings.paused));
  $<HTMLButtonElement>("#step").disabled = !settings.paused;
  persistNum.value = String(settings.persistence);
  persistRange.value = String(Math.min(settings.persistence, Number(persistRange.max)));
  $("#msm-detail").hidden = settings.model !== "msm";
  $("#vol-title").textContent = settings.model === "msm" ? "Volatility (MSM)" : "Volatility (GARCH)";
  $("#vol-hint").textContent =
    settings.model === "msm"
      ? "8 layers multiply together. Each flips between high and low now and then, the slowest every few days, the fastest every second, so calm and busy spells nest inside each other like real markets. Time of day scales it up at the busy hours, and a rare news shock adds a surge that fades over ~10 minutes."
      : "GARCH: big shocks raise volatility for the next few ticks, then it fades back within seconds. Calm and busy spells barely last, so longer charts look like even noise.";
}

// ---- purse and economy ---------------------------------------------------

const hamoud = (x: number): string => Math.round(x).toLocaleString("en-US");

function renderWallet(): void {
  if (!wallet) return;
  $("#balance").textContent = hamoud(wallet.balance);
  const claim = $<HTMLButtonElement>("#claim");
  claim.disabled = !wallet.canClaim;
  if (wallet.canClaim) {
    claim.textContent = `Claim ${hamoud(wallet.dailyReward)}`;
    claim.title = `Tops your balance up to ${hamoud(wallet.dailyReward)} hamoud`;
  } else {
    const hrs = Math.max(0, wallet.nextRewardSec) / 3600;
    claim.textContent = hrs >= 1 ? `Next in ${hrs.toFixed(0)}h` : `Next in ${(hrs * 60).toFixed(0)}m`;
    claim.title = "Already topped up today. Skip ahead to roll the game day over.";
  }
  // Can they afford the selected stake?
  const stake = Number($<HTMLSelectElement>("#trade-stake").value);
  const broke = wallet.balance < stake;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".dir")) b.disabled = broke;
  $("#trade-hint").textContent = broke
    ? `Not enough hamoud for a ${hamoud(stake)} stake — pick a smaller one, or claim your daily top-up.`
    : `UP wins if the price ends above your entry, DOWN if it ends below. A win returns ${hamoud(stake * (1 + settings.payoutRate))}.`;
}

/** Stake choices come from the economy config, so they stay in step with it. */
function renderStakeOptions(stakes: readonly number[]): void {
  const select = $<HTMLSelectElement>("#trade-stake");
  if (select.options.length === stakes.length) return;
  const current = Number(select.value);
  select.replaceChildren(
    ...stakes.map((v) => {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = `${hamoud(v)} hamoud`;
      o.selected = v === current;
      return o;
    }),
  );
}

function renderEconomy(): void {
  const e = economy;
  if (!e) return;
  const goal = e.issuedToday;
  const share = goal > 0 ? e.houseNetToday / goal : 0;
  $("#eco-progress").textContent = `${hamoud(e.houseNetToday)} / ${hamoud(goal)} (${(100 * share).toFixed(0)}%)`;
  const fill = $("#eco-fill");
  // The meter is drawn to 150% of the goal so overshoot is visible too.
  fill.style.width = `${Math.min(100, (100 * share) / 1.5)}%`;
  fill.style.background = share > 1.1 ? "var(--down)" : share > 0.85 ? "var(--up)" : "var(--accent)";
  $("#eco-issued").textContent = hamoud(goal);
  $("#eco-staked").textContent = hamoud(e.stakedToday);
  $("#eco-paid").textContent = hamoud(e.paidOutToday);
  $("#eco-net").textContent = hamoud(e.houseNetToday);
  $("#eco-players").textContent = String(e.players);
  $("#eco-win").textContent =
    e.decidedToday > 0 ? `${(100 * e.realisedWinRate).toFixed(0)}% of ${e.decidedToday}` : "—";
  $("#eco-next").textContent = `${(100 * e.nextWinRate).toFixed(0)}% (break-even ${(100 * breakEven).toFixed(0)}%)`;
  $("#eco-supply").textContent = hamoud(e.supply);
}

// ---- market list --------------------------------------------------------

function renderMarketList(): void {
  const nav = $("#markets");
  const groups = [...new Set(markets.map((m) => m.group))];
  nav.replaceChildren(
    ...groups.flatMap((g) => {
      const h = document.createElement("h3");
      h.textContent = g;
      return [
        h,
        ...markets
          .filter((m) => m.group === g)
          .map((m) => {
            const b = document.createElement("button");
            b.className = "mkt";
            b.dataset.market = m.id;
            b.setAttribute("aria-current", String(m.id === marketId));
            b.setAttribute("aria-label", `${m.name}, ${m.subtitle} — simulated market`);
            b.innerHTML =
              `<span class="icon" style="background:${m.color}">${m.badge}</span>` +
              `<span><span class="nm"></span><br><span class="sb"></span></span>` +
              `<span class="px"><span class="p">—</span><small class="c"></small></span>`;
            b.querySelector(".nm")!.textContent = m.name;
            b.querySelector(".sb")!.textContent = m.subtitle;
            b.addEventListener("click", () => {
              if (m.id !== marketId) selectMarket(m.id);
            });
            return b;
          }),
      ];
    }),
  );
  renderQuotes();
}

function renderQuotes(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".mkt")) {
    const q = quotes.get(b.dataset.market!);
    if (!q) continue;
    b.querySelector(".p")!.textContent = fmt(q.price, q.id);
    const c = b.querySelector<HTMLElement>(".c")!;
    c.textContent = `${signed(q.changePct, 2)}%`;
    c.className = `c ${q.changePct >= 0 ? "up" : "down"}`;
  }
  const q = quotes.get(marketId);
  if (q) {
    // The header follows live ticks when they arrive; quotes fill in otherwise.
    if (!lastDetail) $("#m-price").textContent = fmt(q.price);
    const chg = $("#m-chg");
    chg.textContent = `${signed(q.changePct, 2)}% 24h`;
    chg.className = `chg ${q.changePct >= 0 ? "up" : "down"}`;
  }
}

// ---- side panel ---------------------------------------------------------

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderPanel();
  });
}

function renderPanel(): void {
  const d = lastDetail;
  const f = state.forming;

  $("#mom-hint").textContent =
    settings.persistence > 0
      ? `On (${settings.persistence}s). Part of the last push carries into this tick, so moves run on instead of reversing — fuller bodies, shorter wicks.`
      : "Off. Every tick is independent, so the price zig-zags inside the candle — that back-and-forth is what draws the wicks.";

  if (d) {
    $("#clock").textContent = `${hhmmss(d.ts)} UTC`;
    $("#m-price").textContent = fmt(d.price);
    $("#z").textContent = signed(d.z, 2);
    setBar($("#z-bar"), d.z / 3);
    $("#vol").textContent = `×${d.volMultiple.toFixed(2)} of normal`;
    renderSpark();
    renderLayers(d);
    $("#tod").textContent = `×${d.intraday.toFixed(2)}`;
    const newsEl = $("#news");
    newsEl.textContent = d.news >= 0.05 ? `+${d.news.toFixed(1)}× fading` : "calm";
    newsEl.className = `v ${d.news >= 0.5 ? "flag" : ""}`;

    if (settings.persistence > 0) {
      $("#mom").textContent = signed(d.momentum, 2);
      setBar($("#mom-bar"), d.momentum / 3);
    } else {
      $("#mom").textContent = "off";
      setBar($("#mom-bar"), 0);
    }

    const steering = openTrades.some((t) => t.market === marketId);
    $("#steer").textContent = steering
      ? `${signed(d.steer, 2)}σ${d.snap !== 0 ? ` · snap ${moveText(d.snap)}` : ""}`
      : "none";
    $("#steer-hint").textContent = steering
      ? "Pull toward the open trade's target, in units of one tick's normal move (capped at 1.5σ). In the last 6 s a snap eases the price onto the target."
      : "Only active while this market has an open trade.";

    const diff = d.price - d.prevPrice;
    const move = $("#move");
    move.textContent = `${fmt(d.prevPrice)} → ${fmt(d.price)}  ${moveText(diff)}`;
    move.className = `v ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`;
  }

  if (f) {
    const total = TIMEFRAME_SEC[timeframe] / stampSec;
    const n = Math.min(total, Math.floor((lastDetail ? lastDetail.ts - f.openTs : 0) / stampSec) + 1);
    $("#tickpos").textContent = `tick ${n} / ${total}`;
    $("#forming-title").textContent = `Forming ${timeframe} candle · opened ${hhmm(f.openTs)}`;
    $("#o").textContent = fmt(f.o);
    $("#h").textContent = fmt(f.h);
    $("#l").textContent = fmt(f.l);
    $("#c").textContent = fmt(f.c);
    renderCandle(f);
  }
  $("#effect").textContent = lastEffect;

  const ranged = state.candles.filter((c) => c.h > c.l);
  const body = ranged.length
    ? (100 * ranged.reduce((s, c) => s + Math.abs(c.c - c.o) / (c.h - c.l), 0)) / ranged.length
    : 0;
  $("#stats").textContent = `SIMULATED · ${state.candles.length} closed ${timeframe} candles · body averages ${body.toFixed(0)}% of range`;

  renderPositions();
  renderWallet();
  renderEconomy();

  const ul = $("#log");
  ul.replaceChildren(
    ...logLines.map((line) => {
      const li = document.createElement("li");
      li.textContent = line.text;
      if (line.close) li.className = "close";
      return li;
    }),
  );
}

function renderLayers(d: TickDetail): void {
  const box = $("#layers");
  if (!d.layers) {
    box.replaceChildren();
    return;
  }
  if (box.children.length !== d.layers.length) {
    box.replaceChildren(
      ...d.layers.map((_, i) => {
        const el = document.createElement("div");
        el.className = "layer";
        el.innerHTML = `<div class="cell"><span></span></div><small>${duration(layerSecs[i] ?? 0)}</small>`;
        el.title = `Layer ${i + 1}: flips about every ${duration(layerSecs[i] ?? 0)}`;
        return el;
      }),
    );
  }
  d.layers.forEach((v, i) => {
    const fill = box.children[i]!.querySelector<HTMLElement>("span")!;
    // Values are m0 (high) or 2 − m0 (low); show high as a full cell.
    fill.style.height = v >= 1 ? "100%" : "30%";
  });
}

function renderPositions(): void {
  const now = lastDetail?.ts ?? 0;
  const openEl = $("#open-positions");
  if (openTrades.length === 0) {
    openEl.replaceChildren(emptyLi("No open positions — hit UP or DOWN to open one."));
  } else {
    openEl.replaceChildren(
      ...openTrades.map((t) => {
        const li = document.createElement("li");
        const total = t.expirySec - t.entrySec;
        const elapsed = Math.max(0, Math.min(total, now - t.entrySec));
        const left = Math.max(0, t.expirySec - now);
        const progressPct = total > 0 ? (100 * elapsed) / total : 0;
        const arrow = t.direction === "UP" ? "▲" : "▼";
        li.innerHTML =
          `<div class="pos-head"><span class="pos-mkt"></span><span class="pos-dir ${t.direction.toLowerCase()}">${t.direction} ${arrow}</span>` +
          `<span class="pos-countdown">${t.market === marketId ? `${left}s left` : "running"}</span></div>` +
          `<div class="pos-prices">entry ${fmt(t.entryPrice, t.market)} · stake ${hamoud(t.stake)} → wins ${hamoud(t.toReturn)}</div>` +
          `<div class="pos-style internal">planned ${t.planned} · target ${fmt(t.targetPrice, t.market)} · ${t.pathStyle} path</div>` +
          `<div class="pos-progress"><div class="fill" style="width:${t.market === marketId ? progressPct.toFixed(1) : 0}%"></div></div>`;
        li.querySelector(".pos-mkt")!.textContent = nameOf(t.market);
        return li;
      }),
    );
  }

  const settledEl = $("#settled-positions");
  if (settledTrades.length === 0) {
    settledEl.replaceChildren(emptyLi("Results appear here when a trade's time runs out."));
  } else {
    settledEl.replaceChildren(
      ...settledTrades.map((t) => {
        const li = document.createElement("li");
        li.innerHTML =
          `<div class="pos-head"><span class="pos-mkt"></span><span class="pos-dir ${t.direction.toLowerCase()}">${t.direction} ${t.direction === "UP" ? "▲" : "▼"}</span>` +
          `<span class="outcome ${t.outcome.toLowerCase()}">${t.outcome} ${t.credited >= t.stake ? "+" : "−"}${hamoud(Math.abs(t.credited - t.stake))}</span></div>` +
          `<div class="pos-prices">entry ${fmt(t.entryPrice, t.market)}  →  exit ${fmt(t.exitPrice, t.market)} · staked ${hamoud(t.stake)}, back ${hamoud(t.credited)}</div>` +
          `<div class="pos-style internal">planned ${t.planned}${t.planned === t.outcome ? "" : " — steering missed"} · ${t.pathStyle} path</div>`;
        li.querySelector(".pos-mkt")!.textContent = nameOf(t.market);
        return li;
      }),
    );
  }
}

function emptyLi(text: string): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "positions-empty";
  li.textContent = text;
  return li;
}

function setBar(el: HTMLElement, value: number): void {
  const v = Math.max(-1, Math.min(1, value)) * 50;
  el.style.left = v >= 0 ? "50%" : `${50 + v}%`;
  el.style.width = `${Math.abs(v)}%`;
  el.style.background = v >= 0 ? "var(--up)" : "var(--down)";
}

function renderSpark(): void {
  const svg = $<SVGSVGElement>("#vol-spark");
  if (volHistory.length < 2) {
    svg.innerHTML = "";
    return;
  }
  const max = Math.max(2, ...volHistory);
  const y = (v: number) => 34 - (v / max) * 32;
  const step = 300 / (SPARK_POINTS - 1);
  const offset = (SPARK_POINTS - volHistory.length) * step;
  const pts = volHistory.map((v, i) => `${(offset + i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  svg.innerHTML =
    `<line x1="0" x2="300" y1="${y(1)}" y2="${y(1)}" stroke="#5b6476" stroke-dasharray="3 3" />` +
    `<polyline points="${pts}" fill="none" stroke="#f0b429" stroke-width="1.5" vector-effect="non-scaling-stroke" />`;
}

function renderCandle(c: Candle): void {
  const svg = $<SVGSVGElement>("#candle-svg");
  const top = 14;
  const bottom = 186;
  const span = c.h - c.l;
  const y = (p: number) => (span === 0 ? 100 : bottom - ((p - c.l) / span) * (bottom - top));
  const up = c.c >= c.o;
  const color = up ? "#26a69a" : "#ef5350";
  const bodyTop = y(Math.max(c.o, c.c));
  const bodyH = Math.max(2, Math.abs(y(c.o) - y(c.c)));
  const label = (yy: number, text: string) =>
    `<text x="96" y="${(yy + 4).toFixed(1)}" fill="#8a93a4" font-size="11" font-family="ui-monospace, Menlo, monospace">${text}</text>`;
  svg.innerHTML =
    `<line x1="50" x2="50" y1="${y(c.h)}" y2="${y(c.l)}" stroke="${color}" stroke-width="2" />` +
    `<rect x="30" y="${bodyTop}" width="40" height="${bodyH}" fill="${color}" rx="1" />` +
    `<line x1="74" x2="90" y1="${y(c.c)}" y2="${y(c.c)}" stroke="#f0b429" stroke-width="1" />` +
    label(y(c.h), "high") +
    label(y(c.l), "low") +
    (Math.abs(y(c.c) - y(c.h)) > 12 && Math.abs(y(c.c) - y(c.l)) > 12 ? label(y(c.c), "now") : "");

  const upper = c.h - Math.max(c.o, c.c);
  const body = Math.abs(c.c - c.o);
  const lower = Math.min(c.o, c.c) - c.l;
  const pct = (x: number) => (span === 0 ? 0 : (100 * x) / span);
  $("#split").innerHTML =
    `<span style="width:${pct(upper)}%;background:#5b6476"></span>` +
    `<span style="width:${pct(body)}%;background:${color}"></span>` +
    `<span style="width:${pct(lower)}%;background:#5b6476"></span>`;
}

// ---- helpers -------------------------------------------------------------

function log(text: string, close: boolean): void {
  logLines.unshift({ text, close });
  if (logLines.length > LOG_LINES) logLines.pop();
}

const pad = (n: number) => String(n).padStart(2, "0");
// UTC, to match the chart's time axis.
function hhmmss(ts: number): string {
  const d = new Date(ts * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function hhmm(ts: number): string {
  return hhmmss(ts).slice(0, 5);
}
function signed(x: number, digits: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;
}
/** 259200 → "3d", 7340 → "2h", 35 → "35s". */
function duration(sec: number): string {
  if (sec >= 86400) return `${Math.round(sec / 86400)}d`;
  if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec)}s`;
}

renderControls();
selectMarket(marketId);
