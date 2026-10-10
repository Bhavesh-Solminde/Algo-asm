# candle-algorithm





## Install

From this folder:

```bash
npm install
```

## Run

Fast demo — no waiting, produces two hours of synthetic candles instantly
and prints the last 10 of each timeframe:

```bash
npm run example:fast
```

Override seed or duration with env vars:

```bash
SEED=1234 MINUTES=240 npm run example:fast
```

Live-cadence demo — ticks every `TICK_DT_SEC` real seconds (5s by default)
the same way the engine does. Runs for 30 seconds unless you tell it
otherwise:

```bash
npm run example
# or:
DURATION_MS=180000 npm run example   # three minutes
```

Live chart in the browser — watch candles being generated tick by tick:

```bash
npm run live        # → http://localhost:5180
```

The server (`live/server.ts`) runs the `AssetRegistry` tick → record
pipeline and streams `candles:history` / `candle:close` / `tick` messages
over Server-Sent Events. The page (`live/client.ts`) folds them with
`applyChartMessage` and draws them with TradingView's
lightweight-charts 5.2.1. Controls:

- **Speed** 1× / 10× / 60× / 300× — chart seconds per real second (at 60× a
  1m candle forms in one second).
- **Pause** + **Step 1 tick** — advance one tick at a time and read, in the
  side panel, the random shock, GARCH volatility, momentum, price move and
  what that tick did to the forming candle.
- **Skip ahead** +15m / +1h / +6h — generate that much history instantly.
- **Wicks** A–E — `trendPersistenceSec` 0 / 40 / 60 / 90 / 120, or any value
  0–600 from the slider / number box in the sidebar's Momentum step (rebuilds
  from the seed so you can compare the same chart).
- **Timeframe** 1m / 5m / 15m / 1h.

Each tick is stamped 1s apart like `example-fast`. `PORT` and `SEED` env
vars override the defaults.

Type-check only:

```bash
npm run typecheck
```

## What goes into one candle

Every tick (`TICK_DT_SEC = 5`s by default — see `src/step.ts`) the engine:

1. **Draws a shock.** `createRng(seed).normal()` returns a standard normal
   `z` (`src/rng.ts`).
2. **Updates volatility.** `stepGarch(state, params, z)` advances a
   GARCH(1,1) conditional variance so quiet patches cluster and busy ones
   cluster (`src/garch.ts`).
3. **Composes one tick.** `stepPrice(...)` combines four layers in log
   space, then clamps the realised move (`src/step.ts`):

   | Layer | What it does |
   |-------|--------------|
   | L1 base   | GBM with the GARCH sigma and short-term momentum (`trendPersistenceSec`) — the honest random walk |
   | L2 drift  | small bounded book-imbalance bias (0 unless the governor is on) |
   | L3 magnet | expiry-convergence pull toward a stamped trade's `targetPrice` |
   | L4 anchor | weak pull toward a real market quote on REAL assets |
   | L5 self-anchor | OTC-only pull toward the asset's own HONEST path |

4. **Records the SHOWN price into every timeframe's candle.**
   `CandleAggregator.addTick(nowSec, shownPrice)` folds the tick into the
   current open bucket; when `floor(ts / timeframeSec)` increments, the
   finished candle is returned and a fresh one starts (`src/candles.ts`).
5. **Broadcasts.** A `tick` goes out every loop iteration; a `candle:close`
   goes out whenever the aggregator closes one. The client folds these into
   its own chart state (`src/client-fold.ts`).

**Candles are built from the SHOWN price, not the pre-governor price.**
A commit-phase snap can be applied AFTER `stepPrice` returns to drag the
chart toward a stamped target in the final `COMMIT_WINDOW_SEC` of a live
trade. `registry.record()` is called with the post-snap price so no
closed bar carries a high or low that no viewer ever saw on their live
chart. With no governor wired in, the snap is a no-op here; candles are
the honest four-layer price.


## The magnet / up-down algorithm

The honest four-layer tick (`src/step.ts`) is only half the story. The other
half is how the chart is steered toward a stamped trade's `targetPrice` so the
settlement — WIN or LOSS — is decided by the house governor rather than by
the random walk. 

Three shapes decide HOW the chart travels:

- **DIRECT** — ramps smoothly toward the target from the start.
- **OSCILLATE** — small-amplitude sine around entry for 60% of the trade,
  then smoothstep convergence over the remaining 40%.
- **FEINT** — first 35% drives AWAY from the target (looks like a market
  going the wrong way), then reverses and converges over the remaining 65%.
  Only picked for trades > 20s so there's room for the fake-out.

Four pieces decide HOW MUCH the chart pulls each tick:

1. `pathBias(style, elapsedFrac)` — the scalar in roughly [-1, +1] from the
   style above.
2. `blendedMagnet(trades, currentPrice, nowSec, sigmaTick)` — multiple live
   trades vote with their liability (`stake · payoutPct / 100`) for a
   log-space direction. Clamped to ±`MAGNET_CAP·sigmaTick` so the pull always
   hides inside normal volatility headroom.
3. **Tightening** — inside the last `MAGNET_WINDOW_SEC` of a trade the pull
   is linearly amplified up to 2× so a bad run of z draws can't wash the
   steering out in the final seconds. Baked into `blendedMagnet`.
4. `commitSnap(shownPrice, trades, nowSec, tickSize)` — the "chart MUST
   end on the right side of the line" correction. In the last
   `COMMIT_WINDOW_SEC` seconds of a stamped trade the shown price is
   smoothstep-blended toward target, with the per-tick displacement clamped
   to `tickSize × MAX_COMMIT_SNAP_MOVE_TICKS` (= 10 ticks per tick) so no
   visible breakout wick appears. Trades drifted beyond what this budget
   can rescue become de-facto HONEST at settlement, which the chart-as-
   source-of-truth settlement handles correctly.

Grandfathered rows (no verdict / HONEST verdict / no path style) contribute
nothing to either function — the chart stays honest wherever every open
trade is HONEST.

Run it:

```bash
npm run example:magnet
STYLE=DIRECT SEED=7 npm run example:magnet
STYLE=OSCILLATE SEED=42 npm run example:magnet
```

The example opens one 60s stamped WIN trade with target 5 ticks above entry,
runs the full tick loop, and prints the shown vs honest price every second
with a stage label (`early` / `tighten` / `commit`). You should see the
chart stray far from target during the FEINT, swing back in `tighten`, and
pin exactly on target in `commit` — while the honest path (same seed, same z
draws, no magnet) lands wherever the random walk points.

## Timeframes

1m is the primary timeframe. 5m / 15m / 1h are built on read by
`resample(...)` from the 1m candles — see `src/candles.ts`. In the fast
example you see all four closed-candle streams, driven by the four
aggregators the registry adds to each asset.

## Working on the algorithm

- Tweak `src/step.ts` and watch the shape of candles change in
  `example-fast.ts`.
- Change `TICK_DT_SEC` in `src/step.ts` to tune cadence.
- Tune `trendPersistenceSec` to control body vs wick. It is off (`0`) by
  default in `example-fast` — every tick is an independent coin flip, the
  price zig-zags inside each candle and the wicks come out about as long as
  the body (body ≈ 51% of the range). `40` → bodies ≈ 68%; `60` → bodies ≈
  72% (demo cadence). At `trendPersistenceSec = 10` on a 5s cadence this
  lands at ~70% body / ~30% wick on NIFTY — chosen for clearly-visible
  retracement wicks. `example-fast` prints the average body share for each
  timeframe so you can see the effect.
- Add another `registry.add({...})` call in either example to run two
  assets side by side; they will share the RNG stream (one call to
  `rng.normal()` per asset per tick) so their paths are correlated by
  construction.
