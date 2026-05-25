# Routing Profiles + Live Re-Route — Implementation Plan

## Goal
Make routing "levers" — `walkReluctance`, `bikeReluctance`, **`waitReluctance`**, **`transferPenalty`**, speeds, transfer buffers — easy to set per-search via **pre-built profiles + a Claude natural-language box**, changeable **without a rebuild to change values**, and reusable for **live re-routing** in Go Mode (user button + auto-suggest on delay/deviation).

## Decisions (2026-05-25)
- Full implementation plan first (this doc), then build.
- Expose levers via **both** a preset profile picker **and** a Claude NL→params box.
- Live re-route triggers **both** a user "find another way" button **and** auto-suggest on delay/off-route.

## Key facts discovered in the codebase
- The GraphQL doc actually sent (`@opentripplanner/core-utils/.../planQuery.graphql`) declares only 5 tunable levers: `bikeReluctance`, `carReluctance`, `walkReluctance`, `walkSpeed`, `wheelchair`. `waitReluctance` / `transferPenalty` are **not plumbed**.
- `apiV2.js routingQuery` builds `baseQuery` with `...currentQuery` spread (`apiV2.js:1168`), and `generateCombinations` preserves extra keys (`combo => ({ ...params, modes: combo })`). So any key set via `setQueryParam` reaches `generateOtp2Query`.
- **But** `generateOtp2Query` re-destructures the 5 named levers from `modeSettingValues` and re-assigns them into `variables` — **shadowing** any `currentQuery` value for those 5. New (un-named) levers flow through `...otherOtpQueryParams` cleanly.
- Runtime query-string override hook: `apiV2.js:1210` uses `config.api.planQuery || query.query`; `main.js:30` wires `config.api.planQuery` from `/tmp/config.js`.
- GraphQL endpoint: relative `/gtfs/v1` (`apiV2.js:121`); OTP host `https://tre.hopto.org`, basePath `/otp` → `https://tre.hopto.org/otp/gtfs/v1`.

## Step 0 — Verify OTP server accepts the new args
Introspect the OTP2 GTFS GraphQL schema to confirm exact top-level `plan(...)` arg names for `waitReluctance`, `transferPenalty`, `minTransferTime`, `bikeSpeed`, `walkBoardCost`. Gate for Step A.

## A — Foundation: plumb arbitrary levers to OTP (one-time build; no rebuild to change values)
- **A1.** Extended `planQuery` doc via the `config.api.planQuery` override hook — superset of core-utils' `planQuery.graphql` plus new `$vars` + `plan(...)` args. Avoids editing `node_modules`. Re-sync on core-utils upgrades.
- **A2.** In `apiV2.js routingQuery`, merge prefs into `query.variables` **after** `generateOtp2Query`:
  ```js
  const query = generateOtp2Query(combo)
  const variables = { ...query.variables, ...pickRoutingPrefs(combo) }
  ```
  Fixes the shadowing of the 5 named levers and carries new levers through, with no core-utils patch. Source: `currentQuery.routingPreferences`.

## B — Profiles as data + applier
- **B1.** `lib/util/routing-profiles.ts`: typed `RoutingProfile = { id, label, description, prefs, clampRanges }`. Pre-built set: Fastest, Minimize walking, Stay seated (fewest transfers), Bike-forward, Avoid biking, Reliable transfers, Accessible.
- **B2.** `applyRoutingProfile(id)` thunk → `setQueryParam({ routingPreferences })` → existing replan path fires.
- **B3.** Persist active profile (URL param + localStorage). Optional: load/merge extra profiles from config/localStorage for runtime authoring.

## C — Search UI: preset picker + Claude NL
- **C1.** Profile dropdown in the batch settings panel → `applyRoutingProfile`.
- **C2.** NL box → Claude maps text → validated/clamped overrides → apply. Needs a small backend endpoint (transitnav Python) since the frontend can't hold an API key; manual paste flow as an interim.

## D — Go Mode live re-route
- **D1.** `reRouteFromCurrentPosition({ profileId?, departAt? })` thunk (current GPS + remaining destination + optional profile → `routingQuery` → candidates).
- **D2.** Reducer `reRoute` sub-state (`status`, candidates).
- **D3.** "Find another way" button in `GoModeScreen`.
- **D4.** Auto-suggest on `CONNECTION_WARNING` (miss) / `ROUTE_DEVIATION` — actionable "Re-route?" prompt, propose not silently swap.
- **D5.** On accept → `endGoMode()` + `beginGoMode(newItinerary)`.

## E — Tests
Profiles unit tests (clamping, prefs mapping); `apiV2` variable-merge test (prefs reach `variables`, override the 5 named); re-route thunk test; auto-suggest notification tests mirroring existing go-mode patterns.

## Sequencing
1. A (+ Step 0) — prove `waitReluctance`/`transferPenalty` reach OTP and change results.
2. B + C1.
3. D1–D3, D5.
4. D4 + C2.

## Real-data compliance (CLAUDE.md)
Re-route uses the same `routingQuery` pipeline → real OTP itineraries only. Claude/profiles only choose lever values within validated ranges; they never fabricate itineraries, times, or routes.
