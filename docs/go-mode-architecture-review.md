# Go Mode — architecture review

Written 2026-08-18. Requested as item 1 of `otp-minneapolis/docs/HANDOFF.md`:
an assessment, not a refactor.

**What I read:** all 38 Go Mode modules (16,270 lines including styles), the
mounted component graph from `responsive-webapp.js` down, the reducer's 41
handlers, the 62 jest test files, the 24 `scripts/verify-*.js`, and
`go-mode-ci.yml`. Every claim below has a file and line behind it.

---

## Verdict

**The util layer is the best code in this app.** 22 modules, pure functions,
documented against the rides that caused them, 24 jest suites, no imports back
into actions or components. That layering is not accidental and it should not
be touched.

**One file carries the whole problem.** `lib/actions/go-mode.ts` is 4,840 lines
— 2.6× the next-largest file in the entire repo (`apiV2.js`, 1,847) — and it is
doing six separate jobs at once while holding a *second, invisible store* of 24
module-level variables and 18 timers running alongside Redux.

Everything else in this document is a consequence of that one fact. The fix is
not a rewrite. It is five extractions, four of which change nothing that runs.

---

## What is actually in that file

| Lines | LOC | Job |
| --- | ---: | --- |
| 1–329 | 329 | imports, 40+ tuning constants, **24 module-level `let`s** |
| 330–523 | 194 | 60 action-type constants + creators |
| 524–890 | 367 | lifecycle: `beginGoMode`, `background`/`return`, `startGoModeTracking`, `endGoMode` |
| 891–1509 | 619 | re-route family: browse, auto-apply, quiet access replan, snapshots |
| 1510–2695 | **1,186** | the entire "I'm already on the bus" onboard flow |
| 2696–3039 | 344 | tracking start, live leg times, `advanceToLeg` |
| 3040–3795 | **756** | `handlePositionUpdate` — one function |
| 3796–4283 | 488 | vehicle matching, onboard route confirm, settings |
| 4284–4478 | 195 | pure geometry (`haversineDistance`, polyline index, timed points) |
| 4479–4840 | 362 | GPS simulation + recorded-track replay |

Two of those rows do not belong in an actions file at any size: 195 lines of
pure geometry, and 362 lines of a test/simulation harness that ships to riders.

### The second store

24 module-level `let`s (lines 139–313) and 18 timers hold real trip state that
Redux never sees: `lastQuietReplanAt`, `quietReplanMissStreak`,
`prevDistanceFromRoute`, `manualDepartureLock`, `earlyBoardReplan`,
`lastTurnCardKey`, `lastPacingCard`, `lastDepartureBaseline`,
`missedBusRerouteAttempt`, the whole simulation block, and more.

The util layer has its own: `turnState` (notification-service.ts:248),
`cueCache`/`cursorCache` (turn-by-turn.ts:180, 293), `watcherId`
(native-gps.ts:42), `sessionStartedAt` (session-persistence.ts:52).

This state is invisible to the redux devtools, invisible to the debug-log,
absent from session persistence, and untouchable from a test. It is also
**per-tab, not per-trip** — and the iOS shell is a WKWebView that is never
reloaded between trips, so it survives every trip the rider takes until they
force-quit the app.

### The tick

`handlePositionUpdate` is 756 lines making roughly twenty decisions per GPS
fix: watchdog heartbeat → route match → riding stickiness and rebind hysteresis
→ leg transition → progress → live boarding time → arrival latch → live-times
refresh → auto-anchor (with a nested departures re-poll) → vehicle matching →
notification pass → alight alerts → deviation → missed-bus classification →
departure drift → push notifications → turn card → pacing card → stuck-reroute
recovery → missed-bus replan → boarded-earlier replan → off-route handling.

19 `dispatch(` calls and 7 `getState()` reads, interleaved, inside a single
function body. The comments in it are excellent — most cite the ride and date
that produced the rule. That is exactly why it must become testable rather than
be rewritten: the knowledge in there is real and expensive.

---

## Four consequences, visible in the code today

### 1. The test pyramid is upside down

The riskiest 756 lines in the app are **unreachable from jest**. Nothing under
`__tests__/` calls `handlePositionUpdate`. The only things that do are eight
`scripts/verify-*.js`, which need a live OTP backend and the `:9967` dev server
— the same tier HANDOFF trap #4 says is flaky when no vehicle is mid-trip and
must be re-run two or three times before you can believe it.

So the four **fixture-driven regression tests** — the ones pinning real
incidents (`turn-storm-0731`, `turn-honesty-0729`, `alight-backwards-0809`,
`alight-route-preservation`) — hand-reimplement the pipeline instead:

```ts
// __tests__/util/go-mode/turn-storm-0731.ts
const match = matchPositionToRoute(...)
const progress = calculateTripProgress(...)
const turn = checkUpcomingTurn(...)
```

That test pins **the utils in the order the test author wrote**, not the order
`handlePositionUpdate` actually runs them. The 7/31 storm can come back through
a change to the sequencing, the guards, or the inputs in the thunk, and all 697
jest tests stay green. The test even carries a comment apologising for the
indirection ("re-reading it here keeps that indirection honest").

Six recorded rides (up to 15 MB each) are sitting in `replay/fixtures/`. They
are the best asset this project has and the engine cannot be pointed at them.

### 2. Lifecycle is hand-maintained, and already has a gap

`endGoMode` (lines 759–851) is 92 lines of hand-written teardown resetting ~20
of the 24 module variables one at a time. Add a `let`, remember to add a line
here — or don't, and it leaks into the next trip.

`notification-service.ts` exports `resetTurnAnnouncements()` for exactly this
purpose. **It has zero callers.** Meanwhile `GoModeScreen.tsx:129–131`:

```ts
const handleRetry = () => {
  if (goMode.activeItinerary) {
    endGoMode()
    beginGoMode(goMode.activeItinerary)   // same object
  }
}
```

`normalizeGoModeItinerary` deliberately "returns the input reference when
nothing merges", so the leg objects are identical, so the `turnState` WeakMap
keyed on `Leg` still holds every cue already announced. Predicted symptom: after
a GPS-error retry, turn announcements for cues already fired stay silent for the
rest of the leg. **Unverified** — it needs a fixture test, and that test cannot
be written today for reason #1. It is the architecture predicting its own bug.

### 3. There is no single answer to "when is this bus"

Three surfaces, three independent sources:

- `TripSheet` → `buildLiveItinerary(activeItinerary, liveLegTimes)`, live times
- `WalkingNavigation` → `departure-anchor` + `departureOverride` + `boardingStopData`
- `TransitProgress` → raw `leg.startTime` straight off the itinerary

The third is currently *honest* — it renders the string "scheduled {time}", so
nothing is lying to the rider right now. But `GoModeScreen:252` hands
`CurrentLegPanel` a raw `goMode.activeItinerary.legs[i]`, and within `TripSheet`
itself `waitSecondsBeforeLeg` (line 121) reads plan times off `legs` while the
list two elements below renders `liveItinerary`. Correctness here rests on each
author remembering which object they hold. HANDOFF says this has already caused
two bugs; the structure that caused them is unchanged.

Also note `Number(leg.startTime)` at TripSheet:121 — guarded by
`Number.isFinite`, so it fails silent rather than `NaN`, which is trap #5
behaving as documented. It means the wait line quietly vanishes on
string-typed times rather than showing something wrong.

### 4. Types live in the effect module

`RidingState` and `LiveLegTime` are declared in `actions/go-mode.ts`. The
reducer imports them from there; so does `util/go-mode/live-itinerary.ts` — the
one place the otherwise-clean util layer reaches back up a level. Every consumer
of a 12-line interface pulls a 4,840-line side-effectful module into its graph.

---

## Dead code, verified

| Thing | Size | Evidence |
| --- | ---: | --- |
| `GoModeHeader.tsx` | 220 | zero importers anywhere in `lib`/`__tests__` |
| its styles in `styled.ts` | 6 exports | `NavigationInstruction`, `InstructionText`, `NextLegPreview`, `SmallProgressTrack`, `SmallProgressFill`, `pulseOpacity` — all unreferenced |
| `reRoute.candidate` / `.candidates` | state | written by the reducer (line 688), **read nowhere** |

On that last one: the reducer comments describe "surfacing the Switch/Keep
card". That card does not exist. The `Reroute*` styled family was reused for
the arrival card (`GoModeScreen:294`) and the onboard buttons
(`AlightRecommendation:98`). `reRoute` is genuinely read — but only as
`status`/`searchId`/`autoApply`/`keepRouteId`/`startedAtMs`, by thunks,
`apiV2.js`, `debug-log.js` and the notification gate. The two candidate fields
are storage for a UI that was never built. Either build it or drop them.

---

## What I would *not* do

- **No rewrite of `handlePositionUpdate`'s rules.** Every branch in it is a
  paid-for lesson with a date attached. This is extraction, not redesign.
- **No changes to the util layer.** It is right.
- **No Redux state-shape changes**, and no state-machine library. The problem is
  where the code lives, not which framework holds it.
- **Do not clone leg objects.** Leg-object identity is load-bearing in three
  places (`turnState`, `cueCache`, `cursorCache` are `WeakMap<Leg, …>`) and
  `spliceAccessOntoItinerary`'s same-objects promise is the 7/29 fix. Any
  refactor that maps over legs and returns new ones breaks the turn-alert latch
  silently.
- **Do not delete a `verify-*.js` until its jest replacement passes on the same
  fixture.** Flaky beats absent.

---

## Recommended shape — five steps, in order

Each is independently shippable and independently revertable.

**0 — Delete the dead code.** `GoModeHeader.tsx`, its six styled exports, and
either build or drop `reRoute.candidate(s)`. ~230 lines, zero risk, minutes.

**1 — Move what was never an action out.** `4284–4478` (geometry) →
`util/go-mode/geometry.ts`; `4479–4840` (simulation + track replay) →
`util/go-mode/simulation.ts`. Pure moves, no behaviour, −557 lines. Watch trap
#7: `sort-imports` is disabled in this file, order imports by hand.

**2 — Move the types.** `RidingState`, `LiveLegTime` and friends →
`util/go-mode/types.ts`. Removes the only upward import in the util layer.

**3 — The one that matters: make the tick testable.** Extract the decision half
of `handlePositionUpdate` into a pure function in the util layer:

```ts
// util/go-mode/tick.ts
export function planTick(input: TickInput): TickIntent[]
```

`TickInput` = the redux slice it reads + the position + `nowMs` + an explicit
per-trip session bag (see step 4). `TickIntent` = a described action, notification,
or effect request. The thunk shrinks to an interpreter: read state → `planTick`
→ apply intents.

Do it **one decision at a time** — turn card, then pacing card, then missed-bus,
then auto-anchor — each slice landing with a fixture test that is checked to
fail against the old code first. Nothing needs to move in one commit.

What this buys, immediately: the six recorded rides become drivable through the
*real* engine; the four hand-reimplemented regression tests get to assert the
actual sequence; and several `verify-*.js` scripts convert from flaky-live to
deterministic-jest, which is the single biggest quality-of-life win available in
this codebase.

**4 — Give the hidden state a home.** Replace the 24 module `let`s with one
`TripSession` object created in `beginGoMode` and dropped in `endGoMode`. The
92-line teardown becomes `session = null`, leaks become structurally impossible,
`resetTurnAnnouncements()` gets its caller, and the session becomes inspectable
by the debug-log and injectable by a test.

**5 — Split the onboard flow.** Lines `1510–2695` are a self-contained feature
with its own reducer sub-slice (`OnboardState`), its own components, and its own
test file. `actions/go-mode-onboard.ts`. Mechanical, −1,186 lines.

After 0–5, `actions/go-mode.ts` is roughly 1,400 lines of lifecycle, re-route
and interpreter — comparable to `apiV2.js`, which nobody complains about. Then
HANDOFF item 6 (the ~60 TypeScript errors) becomes tractable, because the errors
will be spread over ten files that can each be fixed and typechecked alone.

---

---

## Status — updated 2026-08-18, after the first pass

Steps **0, 1 (part), 2 and 4** have landed, along with the §2 bug this review
predicted, and two slices of step 3. `lib/actions/go-mode.ts` is **4,840 →
4,546** lines and its 24 module-level `let`s are down to **4**. Tests **697 →
719**, TypeScript errors **63 → 61**, jest / lint / production build all green.

| Step | State | Result |
| --- | --- | --- |
| 0 — delete dead code | **done** | `GoModeHeader.tsx`, 5 orphan styled exports, `reRoute.candidate(s)` |
| 1 — move what was never an action | **half** | geometry → `util/go-mode/geometry.ts`; simulation **blocked**, see below |
| 2 — move the types | **done** | `util/go-mode/types.ts`; the util layer no longer imports upward at all |
| 3 — make the tick testable | **started** | slices done: the turn card, the pacing card, missed-bus recovery |
| 4 — give the hidden state a home | **done** | `util/go-mode/trip-session.ts`; the 92-line teardown is now one line |
| 5 — split the onboard flow | **blocked**, see below |

Also landed, not in the original plan: `util/go-mode/time.ts` — the canonical
`epochMs()` for trap #5, replacing the `Number(leg.startTime)` idiom in the
extracted geometry and fixing 2 of the TypeScript errors on the way.

### The §2 bug was real

`endGoMode` never called `resetTurnAnnouncements()`, so after a GPS-error retry
— `handleRetry` re-enters `beginGoMode` with the same itinerary object — every
turn cue already announced stayed latched and silent for the rest of the trip.
`__tests__/util/go-mode/turn-latch-reset.ts` was written first and **checked to
fail** against the old code for exactly that reason, then fixed. The reset lives
in `endGoMode` and deliberately **not** in `beginGoMode`: a quiet access replan
re-enters there mid-trip with the transit legs object-identical, and re-arming
the latch then is the 7/31 storm again.

### What step 3's first slice bought

`__tests__/util/go-mode/turn-card-0731.ts` drives the recorded 7/31 ride — 335
fixes, the rider standing still for seven minutes — through the *real* turn-card
decision and asserts it writes the card **once**, not once per fix. That test
could not have been written before: the logic was inline in the thunk, reachable
only from a live OTP backend. It runs in 1.1 seconds.

The remaining slices follow the same shape, which is the one `pacing-card.ts`
already established: `evaluateX(prev, input) → { clear, next, post }`, pure,
clock injected, thunk applies.

**Slice 2 — the pacing card**, and a note on what these slices actually cost.
`evaluatePacingCard` had been pure since it was written, so this one was small:
only the enable gate and the clear were still inline. Moving them gave it the
same `{ clear, next, post }` shape as the turn card, and let
`pacing-card-0731.ts` drive the whole decision from the recorded ride — the
7/31 trip is `BICYCLE → BUS → BICYCLE`, so it is the right ride for a card that
answers "should I go fast or slow?". Over the seven minutes that pushed the
same turn alert 14 times, the pacing card buzzes once and rewrites itself
silently three times (wait 21 → 19 → 17 → 15), never inside its 90 s floor.
Checked to have teeth: zeroing the two cadence constants makes it post on all
335 fixes and fails three of five assertions.

The lesson for the remaining slices: where a pure module already exists, the
work is only pulling the last decisions out of the thunk. Where it doesn't
(auto-anchor, deviation), it is the turn-card shape of job.

**Slice 3 — missed-bus recovery**, and the first slice with no fixture to hold
it against. Detection was already pure (`classifyMissedBus`); what was inline
was the *recovery policy* — re-plan now or not, apply without asking or surface
a card, and the per-departure retry schedule whose whole point is that the
MISSED_BUS alert's 30-minute dedup must not gate trip recovery. The attempt
record was being mutated in place across three branches. It is now
`evaluateMissedBusRecovery` in `util/go-mode/missed-bus-recovery.ts`.

None of the six recorded rides is a missed-bus ride, and the fixtures carry no
recorded notifications, so there is no replay to drive this one. Two things
stand in for it: ten unit tests over the policy, and a **differential check** —
the new function compared against a faithful transcription of the old inline
code across 1,920 combinations of status, definitiveness, attempt record and
clock, agreeing on all three outputs. That transcription was then deleted
rather than kept, because a copy of dead logic rots into false confidence.

One thing found and deliberately not fixed: the retry schedule reads wall-clock
`Date.now()` while every other clock in the tick is simulation-aware, so a
replay at 8× does not reproduce the retry cadence. Changing it changes what the
verify scripts replay, so it is documented in both places and left for a
deliberate decision.

### Two corrections to this review

1. **`pulseOpacity` was not dead.** It is used twice inside `styled.ts` itself;
   the original sweep excluded that file. Five styled exports were dead, not
   six. It is now a private `const` rather than an export.
2. **Step 5 is not a clean split, and step 1's simulation half is not either.**
   `replanFromAboard` is called *from* `handlePositionUpdate` (the boarded-earlier
   recovery), so "the onboard flow" depends on the tick and the tick depends on
   it — moving it to `actions/go-mode-onboard.ts` creates a real import cycle.
   The simulation thunks have the same problem in the other direction: they
   dispatch `handlePositionUpdate`. Neither is a rename away from working, and
   both were left alone rather than forced. Step 3 is the thing that unpicks
   them: once the tick's decisions are pure, what remains in the thunk is small
   enough that the cycle stops mattering.


## Cost and sequencing

Steps 0–2 are an evening and cannot break a ride: nothing executes differently.
Step 3 is the real work — best done as a slice a session, over weeks, each slice
gated on a fixture test and the nightly verify run. Steps 4 and 5 are each about
half a day once step 3 has drawn the boundary.

If only one thing gets done, do **step 3**. It is the difference between a
codebase whose riskiest logic is proven by six recorded rides and one where it
is proven by re-running a flaky script until it passes.

---

## What I need from you

1. **The turn-latch fix ships to riders.** Everything else here is a move; that
   one changes behaviour on the phone. It wants a TestFlight build and a real
   ride before it is trusted.
2. **`reRoute.candidate(s)` were deleted, not built.** Nothing read them, so
   removing them was the reversible choice — but if the Switch/Keep card is
   still wanted, that is a feature decision, and the fields come back with it.
3. **Step 3's pace.** One slice landed (the turn card). The rest — pacing card,
   missed-bus, auto-anchor, deviation — is a slice at a time with a fixture test
   each. Continue now, or hold until after the next TestFlight round?
4. **Steps 1b and 5 need a decision, not more effort.** Both are cyclic as
   written (see the corrections above). They come free once step 3 has shrunk
   the thunk; forcing them first would mean an import cycle or a bigger
   redesign than this review recommended.
