// Browser side of the live demo. Streams frames from /events, folds the
// platform messages with applyChartMessage (the web app's own client fold),
// paints the result with lightweight-charts, and explains the latest tick in
// the side panel.

import {
  CandlestickSeries,
  CrosshairMode,
  createChart,
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
  SettledTradeView,
  Settings,
  TickDetail,
  TradeView,
} from "./server";

const SYMBOL = "AUDNZD_OTC";
const PIP = 0.0001;
const SPARK_POINTS = 240;
const LOG_LINES = 40;

const $ = <T extends Element = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

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
  priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
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

let timeframe: Timeframe = "1m";
let state: ChartState = initialChartState(SYMBOL, timeframe);
let settings: Settings = { speed: 10, persistence: 0, paused: false, winRate: 0.5 };
let stampSec = 1;
let loading = false;
let buffered: DemoMessage[][] = [];

let lastDetail: TickDetail | null = null;
let lastEffect = "—";
const volHistory: number[] = [];
const logLines: { text: string; close: boolean }[] = [];
let openTrades: TradeView[] = [];
let settledTrades: SettledTradeView[] = [];
const priceLines = new Map<string, IPriceLine>();

async function loadHistory(): Promise<void> {
  loading = true;
  buffered = [];
  state = initialChartState(SYMBOL, timeframe);
  const res = await fetch(`/history?tf=${timeframe}`);
  const msg = (await res.json()) as DemoMessage;
  if (msg.type === "candles:history" && msg.timeframe === timeframe) {
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

function handleFrame(frame: DemoMessage[]): void {
  if (loading) {
    buffered.push(frame);
    return;
  }
  for (const msg of frame) {
    switch (msg.type) {
      case "settings":
        settings = msg.settings;
        stampSec = msg.stampSec;
        renderControls();
        break;
      case "reset":
        volHistory.length = 0;
        lastDetail = null;
        lastEffect = "—";
        log("— chart rebuilt —", true);
        void loadHistory();
        return;
      case "candle:close": {
        const next = applyChartMessage(state, msg);
        if (next !== state) {
          state = next;
          paintBar(msg.candle);
          log(
            `${msg.timeframe} CLOSED ${hhmm(msg.candle.openTs)}  O ${msg.candle.o.toFixed(5)} H ${msg.candle.h.toFixed(5)} L ${msg.candle.l.toFixed(5)} C ${msg.candle.c.toFixed(5)}`,
            true,
          );
        }
        break;
      }
      case "tick": {
        const before = state.forming;
        state = applyChartMessage(state, msg);
        const after = state.forming;
        if (after) paintBar(after);
        lastEffect = describeEffect(before, after, msg.price);
        break;
      }
      case "detail":
        lastDetail = msg;
        volHistory.push(msg.volMultiple);
        if (volHistory.length > SPARK_POINTS) volHistory.shift();
        if (settings.speed <= 10 || settings.paused) {
          const d = msg.price - msg.prevPrice;
          log(
            `${hhmmss(msg.ts)}  z ${signed(msg.z, 2)}  vol ×${msg.volMultiple.toFixed(2)}  → ${msg.price.toFixed(5)} (${signed(d / PIP, 1)} pips)`,
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
        addPriceLine(msg.trade);
        log(
          `TRADE OPEN  ${msg.trade.direction}  entry ${msg.trade.entryPrice.toFixed(5)}  → target ${msg.trade.targetPrice.toFixed(5)}  ${msg.trade.pathStyle}`,
          true,
        );
        break;
      case "trade:settle":
        openTrades = openTrades.filter((t) => t.id !== msg.trade.id);
        settledTrades = [msg.trade, ...settledTrades].slice(0, 20);
        removePriceLine(msg.trade.id);
        log(
          `TRADE ${msg.trade.outcome}  ${msg.trade.direction}  exit ${msg.trade.exitPrice.toFixed(5)}  pnl ${signed(msg.trade.pnl / 100, 2)}`,
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

function addPriceLine(trade: TradeView): void {
  // Draw the ENTRY price, not the target. The target is where the magnet is
  // pulling the chart to behind the scenes; the user cares about "is price
  // above or below where I entered". Same UX as every real binary-options
  // platform.
  const line = series.createPriceLine({
    price: trade.entryPrice,
    color: trade.direction === "UP" ? "#26a69a" : "#ef5350",
    lineWidth: 2,
    lineStyle: 2, // dashed
    axisLabelVisible: true,
    title: `${trade.direction} ${trade.id}`,
  });
  priceLines.set(trade.id, line);
}

function removePriceLine(id: string): void {
  const line = priceLines.get(id);
  if (line) {
    series.removePriceLine(line);
    priceLines.delete(id);
  }
}

function resyncPriceLines(): void {
  for (const [id, line] of priceLines) {
    series.removePriceLine(line);
    priceLines.delete(id);
  }
  for (const t of openTrades) addPriceLine(t);
}

function describeEffect(before: Candle | null, after: Candle | null, price: number): string {
  if (!after) return "Bucket already closed — tick ignored.";
  if (!before || before.openTs !== after.openTs) {
    return `Crossed into a new ${timeframe} bucket → new candle opens at ${price.toFixed(5)}.`;
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

const events = new EventSource("/events");
events.onmessage = (e: MessageEvent<string>) => handleFrame(JSON.parse(e.data) as DemoMessage[]);
events.onerror = () => {
  $("#stats").textContent = "disconnected — is the server running?";
};

// ---- controls ----------------------------------------------------------

async function control(body: Record<string, unknown>): Promise<void> {
  const res = await fetch("/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
$("#pause").addEventListener("click", () => void control({ action: settings.paused ? "resume" : "pause" }));
$("#step").addEventListener("click", () => void control({ action: "step" }));
$("#restart").addEventListener("click", () => void control({ action: "restart" }));
$<HTMLSelectElement>("#wicks").addEventListener("change", (e) =>
  void control({ action: "persistence", value: Number((e.target as HTMLSelectElement).value) }),
);

for (const btn of document.querySelectorAll<HTMLButtonElement>(".trade-group .dir")) {
  btn.addEventListener("click", () => {
    const durationSec = Number($<HTMLSelectElement>("#trade-duration").value);
    void control({ action: "trade", direction: btn.dataset.dir, durationSec });
  });
}
for (const btn of document.querySelectorAll<HTMLButtonElement>("#winrate button")) {
  btn.addEventListener("click", () =>
    void control({ action: "winRate", value: Number(btn.dataset.winrate) }),
  );
}

// Sidebar trendPersistenceSec control. Every change rebuilds the chart from the
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

function renderControls(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#tf button")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.tf === timeframe));
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#speed button")) {
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.speed) === settings.speed));
  }
  for (const btn of document.querySelectorAll<HTMLButtonElement>("#winrate button")) {
    btn.setAttribute("aria-pressed", String(Number(btn.dataset.winrate) === settings.winRate));
  }
  $("#pause").textContent = settings.paused ? "Resume" : "Pause";
  $("#pause").setAttribute("aria-pressed", String(settings.paused));
  $<HTMLButtonElement>("#step").disabled = !settings.paused;

  // A value set from the sidebar may not be one of the A–E presets; show it in
  // the header as a "Custom" entry rather than a blank select.
  const wicks = $<HTMLSelectElement>("#wicks");
  const isPreset = [...wicks.options].some(
    (o) => o.dataset.custom === undefined && Number(o.value) === settings.persistence,
  );
  let custom = wicks.querySelector<HTMLOptionElement>("option[data-custom]");
  if (isPreset) {
    custom?.remove();
  } else {
    if (!custom) {
      custom = document.createElement("option");
      custom.dataset.custom = "";
      wicks.append(custom);
    }
    custom.value = String(settings.persistence);
    custom.textContent = `Custom — ${settings.persistence}s`;
  }
  wicks.value = String(settings.persistence);
  persistNum.value = String(settings.persistence);
  persistRange.value = String(Math.min(settings.persistence, Number(persistRange.max)));
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

  // Follows the setting itself, not the last tick — right after a change there
  // may be no tick yet (at 1× the next one is a second away).
  $("#mom-hint").textContent =
    settings.persistence > 0
      ? `On (${settings.persistence}s). Part of the last push carries into this tick, so moves run on instead of reversing — fuller bodies, shorter wicks.`
      : "Off (wicks A). Every tick is independent, so the price zig-zags inside the candle — that back-and-forth is what draws the wicks.";

  if (d) {
    $("#clock").textContent = `${hhmmss(d.ts)} UTC`;
    $("#z").textContent = signed(d.z, 2);
    setBar($("#z-bar"), d.z / 3);
    $("#vol").textContent = `×${d.volMultiple.toFixed(2)} of normal`;
    renderSpark();

    if (settings.persistence > 0) {
      $("#mom").textContent = signed(d.momentum, 2);
      setBar($("#mom-bar"), d.momentum / 3);
    } else {
      $("#mom").textContent = "off";
      setBar($("#mom-bar"), 0);
    }

    const diff = d.price - d.prevPrice;
    const move = $("#move");
    move.textContent = `${d.prevPrice.toFixed(5)} → ${d.price.toFixed(5)}  ${signed(diff / PIP, 1)}p`;
    move.className = `v ${diff > 0 ? "up" : diff < 0 ? "down" : ""}`;
  }

  if (f) {
    const total = TIMEFRAME_SEC[timeframe] / stampSec;
    const n = Math.min(total, Math.floor((lastDetail ? lastDetail.ts - f.openTs : 0) / stampSec) + 1);
    $("#tickpos").textContent = `tick ${n} / ${total}`;
    $("#forming-title").textContent = `Forming ${timeframe} candle · opened ${hhmm(f.openTs)}`;
    $("#o").textContent = f.o.toFixed(5);
    $("#h").textContent = f.h.toFixed(5);
    $("#l").textContent = f.l.toFixed(5);
    $("#c").textContent = f.c.toFixed(5);
    renderCandle(f);
  }
  $("#effect").textContent = lastEffect;

  const ranged = state.candles.filter((c) => c.h > c.l);
  const body = ranged.length
    ? (100 * ranged.reduce((s, c) => s + Math.abs(c.c - c.o) / (c.h - c.l), 0)) / ranged.length
    : 0;
  $("#stats").textContent = `${state.candles.length} closed ${timeframe} candles · body averages ${body.toFixed(0)}% of range`;

  renderPositions();

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
          `<div class="pos-head"><span class="pos-dir ${t.direction.toLowerCase()}">${t.direction} ${arrow}</span>` +
          `<span class="pos-countdown">${left}s left</span></div>` +
          `<div class="pos-prices">entry ${t.entryPrice.toFixed(5)} · ${t.pathStyle} path</div>` +
          `<div class="pos-style">stake ₹${(t.stake / 100).toFixed(0)} · payout ${t.payoutPct}%</div>` +
          `<div class="pos-progress"><div class="fill" style="width:${progressPct.toFixed(1)}%"></div></div>`;
        return li;
      }),
    );
  }

  const settledEl = $("#settled-positions");
  if (settledTrades.length === 0) {
    settledEl.replaceChildren(emptyLi("Settlements will appear here when a position expires."));
  } else {
    settledEl.replaceChildren(
      ...settledTrades.map((t) => {
        const li = document.createElement("li");
        li.innerHTML =
          `<div class="pos-head"><span class="pos-dir ${t.direction.toLowerCase()}">${t.direction} ${t.direction === "UP" ? "▲" : "▼"}</span>` +
          `<span class="outcome ${t.outcome.toLowerCase()}">${t.outcome} ${signed(t.pnl / 100, 2)}</span></div>` +
          `<div class="pos-prices">entry ${t.entryPrice.toFixed(5)}  →  exit ${t.exitPrice.toFixed(5)}</div>` +
          `<div class="pos-style">${t.pathStyle} path</div>`;
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

renderControls();
void loadHistory();
