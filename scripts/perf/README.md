# Responsiveness harness

Measures how fast the app answers a tap, and how much main-thread work it does
while showing results and during a Go Mode ride. Headless Chrome on a
phone-sized, touch-emulated viewport with CPU throttling. Each scenario gets a
fresh browser, which is closed before the next one starts.

| file | what it is |
|---|---|
| `run.js` | the driver: runs scenarios, writes raw JSON plus `summary.json`, prints the table, and with `--gate` checks the budget |
| `collector.js` | the in-page collector, injected before the app loads (long tasks, LoAF, Event Timing, Redux actions, replay ticks, tap->paint probe) |
| `scenarios.js` | the scenarios and the app selectors they tap, each one read from `lib/components` |
| `stats.js` | summaries, the Markdown table, the gate |
| `compare.js` | prints baseline -> candidate per scenario, with deltas |
| `profile-dispatch.js` | CPU profiles of single dispatches, a results-row tap (`PROFILE_ROWTAP=1`) and Go Mode ticks on a settled list (see below) |
| `trace-readback.js` | reads a `TRACE=1` Chrome trace for the GPU read-back wait inside each tap |
| `tools/` | `resolve-top.js` (cpuprofile top-N through source maps to original file:line), `trace-top.py` / `trace-chain.py` (self time per event name and ancestor chains in a Chrome trace) |
| `budget.json` | the budget the gate enforces |
| `baselines/<label>/` | committed baselines (`summary.json`; raw files only when small) |

## Run against :9967 (the shared checkout = main)

```sh
cd <worktree>          # any checkout of this branch; node_modules must resolve
env -u DISPLAY LABEL=main-$(git -C /home/rwt/projects/otprr/otp-react-redux rev-parse --short HEAD) \
  OUT_DIR=$PWD/scripts/perf/baselines CPU_THROTTLE=4 \
  node scripts/perf/run.js --gate scripts/perf/budget.json
```

- `env -u DISPLAY` is required. Without it puppeteer's `newPage()` hangs forever on this host.
- `SCENARIOS=multistop,search-1dest,...` runs a subset (`multistop-28` still works as an alias for `multistop`). If you name a scenario twice, the second run is stored as `<name>~2`, which is how run-to-run noise is measured.
- `summary.json` is merged per `LABEL`, so separate invocations add to one table.
- To re-gate a stored run without starting a browser: `node scripts/perf/run.js --gate scripts/perf/budget.json --summary <summary.json>`.
- To compare two runs: `node scripts/perf/compare.js <baseline summary.json> <candidate summary.json>`.
- Other env: `PERF_DATE=YYYY-MM-DD` pins the search date. Without it, searches use the recorded time of day on the next weekday. `GOMODE_MAX_WALL_S` caps a replay (default 900). `SEARCH_SETTLE_MAX_S` caps the wait for a search to finish landing (default 900). `PERF_ALLOW_FANOUT=1` adds the details screen's "Other stops" tap, which is off by default: it sends about 12 plan queries at once. `PERF_DPR` sets the device pixel ratio (default 2). `PERF_QUIET_CONSOLE=0` is covered below. `SPEEDY` and `TRACE` are covered under "Numbers the phone never pays".

## Run against a worktree (a second dev server on :9968)

The `otp-frontend-dev` container uses **host networking**. Vite's port is fixed
in `vite.config.js` (`server.port: 9967`, `host: 0.0.0.0`; the container's
`HOST=127.0.0.1` env is not what binds it). A second container therefore also
uses host networking and overrides the port on the vite command line. A
bridge-network `-p 9968:9967` would also serve, but the dev proxies to
`localhost:4000` (prefs API) would then point at the container itself.

```sh
WT=/home/rwt/projects/otprr/worktrees/<branch>
# Replay fixtures are untracked and live only in the shared checkout. Copy the
# ones the scenarios use (never git add them):
mkdir -p $WT/lib/util/go-mode/replay/fixtures
for f in 1008-0916-orange-bike gold-74-1105 0921-1605-465-wrongdir green-line-onboard-1135 \
         0921-1646-orange-missedbus ride-1019-0844-aboard-offer; do
  rsync -a /home/rwt/projects/otprr/otp-react-redux/lib/util/go-mode/replay/fixtures/$f.json \
    $WT/lib/util/go-mode/replay/fixtures/
done
VC=/tmp/claude-1000/vite-cache-9968; mkdir -p $VC      # PRIVATE vite deps cache: see the trap below
docker run -d --rm --name otp-frontend-perf --network host \
  -e YAML_CONFIG=/app/port-config.yml -e NODE_ENV=development \
  -v $WT:/app \
  -v /home/rwt/projects/otprr/otp-react-redux/node_modules:/app/node_modules \
  -v $VC:/app/node_modules/.vite \
  -v /home/rwt/projects/otp-minneapolis/frontend/port-config.yml:/app/port-config.yml:ro \
  -w /app node:20-alpine sh -c "yarn vite --host 127.0.0.1 --port 9968 --strictPort"
# wait for "ready" in `docker logs -f otp-frontend-perf`, then load the page
# ONCE before measuring: the first load optimises deps (a 504 "Outdated
# Optimize Dep" + full reload) and that must not land inside a scenario.
env -u DISPLAY APP_URL=http://127.0.0.1:9968/ SERVED_TREE=$WT LABEL=<branch>-<sha> OUT_DIR=... \
  node scripts/perf/run.js
docker stop otp-frontend-perf
```

Verified on 2026-10-20. :9968 served `34a01dc5a`, and :9969 served
`611685a39` and later `e40041a54` (`--port 9969`, each with its own cache
directory). The search, details and Go Mode scenarios all ran against them.
`back-feedback` did not complete; see the caveats.

**Trap: the vite deps cache.** The worktree container borrows the shared
`node_modules`. Vite keeps its pre-bundled deps in `node_modules/.vite/deps`,
so without the `$VC` mount the second server rewrites the directory :9967 is
serving from. On 2026-10-20 a container started at 13:37:41 without the mount
rewrote it at 13:38:05, just as `otp-frontend-dev` came back from a restart.
From then on every :9967 load threw React's "Invalid hook call", the symptom
of two React copies. The same code served with a private cache loaded clean.
The repair is to clear that directory and restart :9967:
`docker exec otp-frontend-dev rm -rf /app/node_modules/.vite/deps && docker restart otp-frontend-dev`.

`--host 127.0.0.1` keeps the perf server off the LAN: the config's
`host: 0.0.0.0` would otherwise bind every interface on a host-network
container. When Vite starts it empties and rewrites `tmp/` and `index.html` in
the mounted tree, so apart from the deps cache above the dev server only ever
touches its own worktree. It never writes to the shared checkout's
`tmp/config.yml`. `SERVED_TREE` makes `summary.json` record the served sha and
dirty status. On :9967 the shared checkout is assumed. Vite serves the working
tree, and HMR picks up merges live, so record what was served rather than
trusting a label.

## CPU profiles of a single dispatch (`profile-dispatch.js`)

```sh
# a no-op dispatch pair (POSITION_FETCHING + POSITION_RESPONSE) on a settled 28+ row list
env -u DISPLAY APP_URL=... SERVED_TREE=... PROFILE_SEARCH=multistop PROFILE_MIN_ROWS=28 OUT=<dir> \
  node scripts/perf/profile-dispatch.js
# the same on a 2-row list, for contrast
env -u DISPLAY ... PROFILE_SEARCH=short OUT=<dir> node scripts/perf/profile-dispatch.js
# one route-row timetable fill cycle while the list loads (the 1-dest search has qualifying rows)
env -u DISPLAY ... PROFILE_SEARCH=onedest PROFILE_FILL=1 OUT=<dir> node scripts/perf/profile-dispatch.js
# Go Mode ticks: replay in real time, 30 s window once aboard, no taps
env -u DISPLAY ... PROFILE_GOMODE=gold-74-1105 OUT=<dir> node scripts/perf/profile-dispatch.js
# re-print a saved profile's group table and top 30 (needs the dev server up to read dep source maps)
APP_URL=... node scripts/perf/profile-dispatch.js --regroup <file.cpuprofile>
```

Each run writes a `.cpuprofile` file (open it in DevTools > Performance) and
a `.txt` file. The `.txt` holds the dispatch wall times (three unprofiled, one
profiled), self time grouped as react render / maplibre / app logic /
debug-log / other, and the top 30 functions by self time. Pre-bundled dep
chunks are attributed to a package through their source maps. The default
here is `CPU_THROTTLE=1`, so absolute times compare with a phone; the dev
build's own overhead is still included. These runs plan against the same OTP
and honour the same prod-idle wait. `PROFILE_QUIET_S` (default 30) is how long
a list must stay unchanged before it counts as settled.

## Numbers the phone never pays (SPEEDY, TRACE, first mounts)

Two dev-environment costs used to be gated as app latency (75.35). Both are now
separated out.

**SPEEDY (dev-only CSS re-parse).** The pre-bundled styled-components 5.3.1
turns "speedy" (CSSOM `insertRule`) OFF in development, so each injected rule
is a text-node `insertBefore` and Blink re-parses the whole sheet. A cold
results-row tap at 1x was 521-633 ms for that reason, 183 ms with it off; the
cold trip-sheet open 646 -> 233 ms. The production bundle never does it. The
library reads a global `SC_DISABLE_SPEEDY` before its `NODE_ENV` fallback, so
`run.js` sets `window.SC_DISABLE_SPEEDY = false` with `evaluateOnNewDocument`
before the app loads, exactly the production behaviour.

- `SPEEDY=1` forces it on, `SPEEDY=0` leaves the dev behaviour.
- **Default: on whenever there is a served dev tree** (`SERVED_TREE` set, or `APP_URL` on :9967), which is every run against Vite. `summary.json` records `speedy`; `compare.js` warns when the two runs differ.
- With `SPEEDY=0`, the first tap of each kind of label in a scenario (`results-row-0`, `sheet-open`, ... a "first mount") is flagged `firstMount` and left out of the gated p95.
- Do not compare a SPEEDY run with a pre-75.35 baseline without reading the warning: the committed baselines were taken with speedy OFF.

**GPU read-back (SwiftShader).** When the list view resizes the map canvas
(`_resizeCanvas`, maplibre-gl `map.ts`), the commit calls `GLES2::ReadPixels`
and the main thread blocks in `CommandBufferProxyImpl::WaitForGetOffset` until
the software GPU drains its command buffer: 808 / 879 ms of the 827 / 895 ms
long task behind the multistop "View all options" back (2026-10-28). That is
the same ~0.8 s at 1x and at 4x CPU, and a phone's GPU does not do it.
`TRACE=1` records a Chrome trace per search scenario (`TRACE_ALL=1` for replays
too; a 15 min replay trace is GBs and over 450 MB is not parsed), finds every
`WaitForGetOffset` span on the renderer main thread, and subtracts the part
inside each tap's touchstart-to-paint window. The summary then carries, per
tap, `readbackMs`, and per scenario `taps.noReadback` and `taps.gated`
(minus read-back, and minus first mounts when speedy is off); the table has a
"gated p95 (basis)" and a "GPU read-back ms" column. **The gate uses
`taps.gated.p95` when present**, falling back to the raw p95 for older
summaries. Without `TRACE=1` the raw number includes the read-back, so
paint-bound taps (results back, sheet open with the map) still read about
0.8 s too slow; run with `TRACE=1` before reading a budget failure on them.

## What the numbers mean

- **tap->paint** is measured from the touch's `touchstart` timestamp to the
  second `requestAnimationFrame` after the last handler-bearing event of the
  tap: the `touchend`, or the `click` Chrome synthesises from it. That frame
  shows whatever the handlers changed. For a map pan the clock starts at the
  `touchend`. Each tap also records the browser's own Event Timing duration
  (`eventTimingMs`) as a cross-check.
- **long tasks** come from PerformanceObserver `longtask` (> 50 ms). Each of
  the top tasks lists the Redux actions recorded *inside* it and the nearest
  action *before* it.
- **actions**: the store has no hook once it is created. Action types are read
  from the dev server's redux-logger line (`console.log('%c action', css,
  action)`). The timestamp is when the logger printed, which is after the
  reducers and the synchronous react-redux render. The gap between two actions
  in one task is therefore the cost of the second.
- **per-tick work** (Go Mode): one tick is one replay timer callback, the one
  that dispatches `UPDATE_SIMULATION_PROGRESS`. Its work is the larger of the
  callback's synchronous time and the long task that contains it. This is a
  per-tick number, independent of `speedMultiplier`. Time compression changes
  how many ticks land per wall second (`ticksPerWallSecond`), not what each
  tick costs.
- **steady Go Mode**: long tasks that contain a tick and do not fall within a
  tap's window (from 50 ms before the tap to 1 s after its paint).
- **replay**: `finished` means the track ran to its last fix by itself.
  `capped` means it hit `GOMODE_MAX_WALL_S`. Each replay's own progress is
  sampled every second (`info.replay.samples` in the raw file), so a stall in
  the harness can be told apart from a stall in the replay.

## Caveats

- **Dev build.** :9967 and :9968 serve Vite's unbundled, unminified dev
  build. Absolute numbers are an upper bound on the phone's production bundle,
  so compare runs against each other (ratios) and treat absolutes with care.
  Headless Chrome rasterises with SwiftShader, so paint-bound numbers (the map)
  are also pessimistic.
- **redux-logger is silenced.** `lib/main.js` adds `createLogger()` when
  `NODE_ENV === 'development'`. On every dispatch it would `console.group` and
  log the previous and next state, and with puppeteer's Runtime domain attached
  each call is serialised across CDP. The phone never pays that. The collector
  therefore turns `console.log/info/debug/group*` into no-ops before the app
  loads, keeping `warn`/`error`, and still reads action types from the logger's
  arguments. `PERF_QUIET_CONSOLE=0` turns the console back on, to measure how
  much the logger distorts the numbers.
- **The debug-log middleware stays on**, because it runs on the phone too
  (`createDebugLogMiddleware`, `lib/util/debug-log.js`). Browsers are opt-in for
  *sending*, so the middleware's digest and summary run but `push()` returns
  early. The phone, which defaults diagnostics on, also pays for buffering and
  flushing. The harness never opts in: that would stream test sessions into
  the production ride log that ride-watch pages from.
- **Live plans hit PRODUCTION OTP.** :9967's config points at
  `api.transit-nav.com`, which `/etc/hosts` maps to the Linode. The search
  scenarios (`multistop-28`, `search-1dest`, `details`) send real plan queries.
  Run one scenario at a time and one query at a time, and never fan out.
  Before each live-plan scenario, `run.js` waits until no other plan-query
  process is alive (`PERF_PROD_BUSY_PATTERN`, default `node capture.js`) and
  no other holder has the lock file `PERF_PROD_LOCK`
  (`/tmp/claude-1000/perf-prod.lock`, JSON `{pid, since, what}`). It writes
  that lock file itself for the scenario's duration. Any other tool that plans
  against prod should honour the same file. If a busy process shows up
  mid-scenario, the summary notes it. `--no-wait-for-prod-idle` or
  `PERF_WAIT_PROD_IDLE=0` turns the wait off.
- **Replays do not plan against OTP.** While a replay is armed, every GraphQL
  read is served from the fixture (`replay-engine.ts` `resolveReplayQuery`).
  The raw file's `network.requests` shows what did go out (route and feed
  REST reads, the places API).
- **One Chrome at a time.** The host is memory-constrained. Never run two
  harnesses at once, and never run bare `yarn jest` next to :9967 (it clobbers
  `tmp/config.yml`; `docker restart otp-frontend-dev` repairs that).
- **`back-feedback` hung because of a dialog, not the app (75.35 P9).** Its
  old second step tapped the Go Mode card's "<-" (`button[aria-label="Back"]`,
  `CardBackButton`, `onClick={onExit}` -> `GoModeScreen.handleExit`), which ENDS
  the trip behind a `window.confirm`. Nothing answered it, so every later CDP
  call blocked (the "page unresponsive" of 2026-10-20 at 4x and 1x). `launch()`
  now dismisses every dialog and logs it (a note and `summary.dialogs`), and
  the scenario uses only the real ways out of a running trip: app menu ->
  Share feedback, and app menu -> Plan Trip (both background the trip, via
  `_handleNavigate`), each followed by the return-to-trip banner. It notes if
  Go Mode is no longer active at the end. Each step is still bounded (120 s)
  and so is every `page.evaluate` (`PERF_EVAL_TIMEOUT_S`, 120 s).
- **A scenario that hangs keeps what it finished (75.35 P8c).** Taps are
  copied node-side as they complete; if the page cannot be read back, the
  summary holds those taps and the host load, is marked `partial`, and the gate
  FAILS it (its long-task and tick columns are unknown, not zero).
- **`reroute` is two plain replays.** No replay can produce a faster-route
  offer: the replay start path never arms the aboard route check, and a
  rider-made swap is not replayed (findings-replay R2). Its `offer-switch` /
  `offer-keep` taps are only exercised if that changes. `info.noOfferPossible`
  and a note say so.
- **`multistop` has no row count in its name.** It was `multistop-28`; the
  desktop OTP gives 15 itineraries, production gave 31 on 2026-10-20. The
  settled itinerary and DOM row counts are in the summary
  (`search.settled`) and in the table's scenario cell.
- **The committed baselines were taken against PRODUCTION OTP, with speedy OFF
  and the GPU read-back included.** `before-34a01dc5a`, `after-611685a39` and
  `after-e40041a54` ran `:9967` / `:9968` / `:9969` whose config points at
  `api.transit-nav.com`, so their search rows (and the `multistop-28` row
  counts) are production's, and their tap p95 is the raw figure. A run against
  an isolated desktop OTP (15 itineraries) is not like-for-like with them.
- **Never submit feedback.** `back-feedback` only opens the feedback screen
  and backs out. A submitted report goes to the ride-note sink.
