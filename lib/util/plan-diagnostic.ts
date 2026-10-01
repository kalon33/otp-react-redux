/**
 * Why a search that asked for transit came back without any — asked of the
 * server, once, and written into the debug stream (backlog 22.2).
 *
 * The 2026-09-21 09:25:58 search `6wdj06ddu` (2345 Old Shakopee Rd W ->
 * 19925 Idealic Ave, Lakeville, depart 09:00) fanned out into three plans and
 * the rider got ONE card, a 25 283 m / 94 min direct bike:
 *
 *   index 0  [TRANSIT]             0 itineraries, routingErrors
 *                                  [{NO_STOPS_IN_RANGE, TO}]
 *   index 1  [BICYCLE]             1 itinerary, the direct bike
 *   index 2  [TRANSIT, BICYCLE]    the SAME direct bike, routingErrors []
 *
 * Index 2 is the interesting one and it said nothing at all: a transit-bearing
 * request, no transit in the answer, and no routing error to explain it. Nine
 * serial read-only plans against production 10:42-10:55 the same morning —
 * including the rider's exact variables, reconstructed from the action stream —
 * returned 13 itineraries with 12 transit every time (best BICYCLE 2 212 m ->
 * Orange Line -> BICYCLE 15 516 m, 74 min, generalizedCost 4067, against the
 * bike's 4455). The failure did not reproduce 80 minutes later and no server
 * config is implicated: `router-config.json` is not to be changed for this.
 *
 * What is left is server state that only the moment itself can show — either
 * the itinerary-filter chain deleted every transit itinerary (silent, because
 * `itineraryFilters.debug` is "off" on the deployment and the client sends no
 * debug flag), or RAPTOR's windowed search found no path while the heuristic
 * did. OTP will say which, but only if it is asked with the filter-chain debug
 * turned on: with `debugItineraryFilter: true` the filters TAG itineraries with
 * `systemNotices` instead of deleting them.
 *
 * So: ask once more, with the flag on, and record the tags. This module is the
 * pure half — the query surgery, the trigger, the summary and the once-per-
 * search gate. `actions/apiV2` does the dispatching.
 *
 * The field is `debugItineraryFilter: Boolean` on `plan()`
 * (`schema.graphqls:1503` in the deployed fork, OTP 2.9.0-SNAPSHOT 75457ac5;
 * `LegacyRouteRequestMapper.java:135` reads it), and the tags come back as
 * `Itinerary.systemNotices: [SystemNotice]!` with `tag`/`text`
 * (`schema.graphqls:715`, `:2493`). `itineraryFilters: {debug: LIST_ALL}` —
 * the spelling in the server's own speed-test config and in the 6.50 recipe's
 * prose — is NOT a valid plan() argument on this OTP and was rejected when the
 * cycle-1 probe tried it.
 */

/**
 * How many itineraries the record carries a row for. The whole record must stay
 * under the debug sink's MAX_PAYLOAD_CHARS (4000) or it is replaced by a
 * `__summary` stub and says nothing — which is exactly how backlog 16.6 lost
 * the 2026-09-15 evidence. Twelve rows at ~100 chars each leaves room for the
 * variables, the counts and the full tag histogram. The rows are ordered
 * transit-first, because a deleted transit itinerary is the thing being looked
 * for; anything past the cap is counted in `rowsOmitted` and still appears in
 * `noticeCounts`.
 */
export const DIAGNOSTIC_MAX_ROWS = 12

/**
 * The diagnostic re-sends the rider's own variables, stop cap included — a
 * cap-10000 plan, measured at 10-11 s serial against production (backlog
 * 17.8). It must: a cheaper question does not diagnose the expensive one's
 * answer. What keeps that honest is that it is serial (it runs through
 * `runPlanQuery`'s bound, after everything else including 14.2's widening has
 * settled), once per search id, and no more than once a minute across the
 * session. 60 s also folds away the app's own 0.4-0.9 s twin searches and the
 * rider's immediate retry — the 09-21 failure was re-run by hand at 09:26:43,
 * 45 s later, with a byte-identical answer, and a second record of it would
 * have added nothing.
 */
export const DIAGNOSTIC_MIN_INTERVAL_MS = 60000

/** Bounded so a long session cannot grow the set of claimed search ids. */
const MAX_CLAIMED_SEARCHES = 50

const claimedSearchIds = new Set<string>()
let lastDiagnosticAt = 0

/**
 * Take the one diagnostic this search is allowed, or refuse. Returns true at
 * most once per search id, and at most once per DIAGNOSTIC_MIN_INTERVAL_MS.
 */
export function claimRoutingDiagnostic(
  searchId?: string | null,
  nowMs: number = Date.now()
): boolean {
  if (!searchId) return false
  if (claimedSearchIds.has(searchId)) return false
  if (
    lastDiagnosticAt &&
    nowMs - lastDiagnosticAt < DIAGNOSTIC_MIN_INTERVAL_MS
  ) {
    return false
  }
  claimedSearchIds.add(searchId)
  if (claimedSearchIds.size > MAX_CLAIMED_SEARCHES) {
    const oldest = claimedSearchIds.values().next().value
    if (oldest !== undefined) claimedSearchIds.delete(oldest)
  }
  lastDiagnosticAt = nowMs
  return true
}

/** Test seam: forget which searches have already been diagnosed. */
export function resetRoutingDiagnosticGate(): void {
  claimedSearchIds.clear()
  lastDiagnosticAt = 0
}

/**
 * Index of the first `{` that is not inside the operation's variable
 * definitions or inside a string, i.e. the start of the selection set.
 */
function selectionSetStart(src: string): number {
  let depth = 0
  let inString = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === '{' && depth === 0) return i
  }
  return -1
}

/** The text between `src[openIndex] === '('` and its matching `)`. */
function slicedParens(src: string, openIndex: number): string | null {
  if (src[openIndex] !== '(') return null
  let depth = 0
  let inString = false
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(openIndex + 1, i)
    }
  }
  return null
}

/**
 * The rider's question again, with the filter-chain debug on and a tiny
 * selection set.
 *
 * The variable declarations and the `plan()` arguments are copied VERBATIM out
 * of the query the rider's own plan was sent with, so the diagnostic asks the
 * identical question — every lever, the mode list, the stop cap, the search
 * window, the route preference. It is not re-derived from a second copy of the
 * argument list here, because a second copy drifts: `extendPlanQueryWithLevers`
 * adds ten arguments the core-utils document has never heard of, and
 * `config.api.planQuery` can replace the document outright.
 *
 * What it does NOT copy is the selection set. The rider's query asks for full
 * legs including `legGeometry { points }`; with `debugItineraryFilter: true`
 * OTP returns the DELETED itineraries too, so at `numItineraries: 40` the same
 * selection set would be hundreds of kilobytes over a cell link for an answer
 * nobody renders. The diagnostic needs the tags and enough to identify the
 * itinerary, and asks for nothing else.
 *
 * Returns null when the document is not a recognisable `plan` query — a
 * diagnostic that cannot declare the flag would be an ordinary re-plan that
 * silently answers nothing, which is worse than not asking.
 */
export function buildDiagnosticPlanQuery(riderQuery: string): string | null {
  if (typeof riderQuery !== 'string' || !riderQuery.trim()) return null

  const selection = selectionSetStart(riderQuery)
  if (selection < 0) return null

  // Operation variable definitions, if the operation declares any.
  let decls = ''
  const head = riderQuery.slice(0, selection)
  const declOpen = head.indexOf('(')
  if (declOpen >= 0) {
    const inner = slicedParens(head, declOpen)
    if (inner === null) return null
    decls = inner.trim()
  }

  // The plan() argument list, if it has one.
  const planCall = /(^|[^A-Za-z0-9_])plan\s*(\(|\{)/.exec(riderQuery)
  if (!planCall) return null
  let args = ''
  if (planCall[2] === '(') {
    const open = planCall.index + planCall[0].length - 1
    const inner = slicedParens(riderQuery, open)
    if (inner === null) return null
    args = inner.trim()
  }

  const declList = decls
    ? `${decls}\n  $debugItineraryFilter: Boolean`
    : '$debugItineraryFilter: Boolean'
  const argList = args
    ? `${args}\n    debugItineraryFilter: $debugItineraryFilter`
    : 'debugItineraryFilter: $debugItineraryFilter'

  return `query PlanDiagnostic(
  ${declList}
) {
  plan(
    ${argList}
  ) {
    routingErrors {
      code
      inputField
    }
    itineraries {
      duration
      generalizedCost
      startTime
      systemNotices {
        tag
      }
      legs {
        mode
        transitLeg
        route {
          gtfsId
          shortName
        }
      }
    }
  }
}`
}

interface DiagnosticLeg {
  mode?: string | null
  route?: { gtfsId?: string | null; shortName?: string | null } | null
  transitLeg?: boolean | null
}

interface DiagnosticItinerary {
  duration?: number | null
  generalizedCost?: number | null
  legs?: DiagnosticLeg[] | null
  systemNotices?: Array<{ tag?: string | null } | null> | null
}

/** One line of the record: what came back and what the filter chain said of it. */
export interface DiagnosticRow {
  cost?: number
  minutes?: number
  notices: string[]
  routes?: string[]
  transit: boolean
}

export interface DiagnosticSummary {
  itineraries: number
  noticeCounts: Record<string, number>
  routingErrors: Array<{ code?: string; inputField?: string }>
  rows: DiagnosticRow[]
  rowsOmitted: number
  transitItineraries: number
}

function toRow(itin: DiagnosticItinerary): DiagnosticRow {
  const legs = Array.isArray(itin?.legs) ? itin.legs : []
  const transitLegs = legs.filter((leg) => leg?.transitLeg)
  const routes = transitLegs
    .map((leg) => leg?.route?.shortName || leg?.route?.gtfsId || leg?.mode)
    .filter((name): name is string => !!name)
  const row: DiagnosticRow = {
    notices: (itin?.systemNotices || [])
      .map((notice) => notice?.tag)
      .filter((tag): tag is string => !!tag),
    transit: transitLegs.length > 0
  }
  if (typeof itin?.generalizedCost === 'number') row.cost = itin.generalizedCost
  if (typeof itin?.duration === 'number') {
    row.minutes = Math.round(itin.duration / 60)
  }
  if (routes.length > 0) row.routes = routes
  return row
}

/**
 * The diagnostic answer, small enough to survive the sink's per-entry cap.
 *
 * `noticeCounts` is the histogram the next occurrence is read off: a
 * `transit-vs-street-filter` count above zero means OTP built transit chains
 * and the cost filter deleted them (the row's mechanism (a), which the cycle-1
 * re-measurement could not reproduce); only `outside-search-window` /
 * `number-of-itineraries-filter` / `similar-legs-filter-*` and a transit count
 * of zero means RAPTOR built nothing to delete.
 */
export function summariseDiagnosticPlan(
  payload: unknown,
  maxRows: number = DIAGNOSTIC_MAX_ROWS
): DiagnosticSummary {
  const plan = (payload as { data?: { plan?: unknown } } | null)?.data?.plan as
    | {
        itineraries?: DiagnosticItinerary[] | null
        routingErrors?: Array<{
          code?: string | null
          inputField?: string | null
        } | null> | null
      }
    | null
    | undefined
  const itineraries = Array.isArray(plan?.itineraries) ? plan!.itineraries! : []
  const rows = itineraries.map(toRow)
  const noticeCounts: Record<string, number> = {}
  rows.forEach((row) =>
    row.notices.forEach((tag) => {
      noticeCounts[tag] = (noticeCounts[tag] || 0) + 1
    })
  )
  // Transit first: a tagged transit itinerary is the whole point of asking.
  const ordered = [
    ...rows.filter((row) => row.transit),
    ...rows.filter((row) => !row.transit)
  ]
  return {
    itineraries: rows.length,
    noticeCounts,
    routingErrors: (plan?.routingErrors || [])
      .filter((err): err is { code?: string; inputField?: string } => !!err)
      .map((err) => ({
        code: err.code ?? undefined,
        inputField: err.inputField ?? undefined
      })),
    rows: ordered.slice(0, maxRows),
    rowsOmitted: Math.max(0, ordered.length - maxRows),
    transitItineraries: rows.filter((row) => row.transit).length
  }
}

interface AnsweredPlan {
  capBearing?: boolean
  index: number
}

interface StoredResponse {
  error?: unknown
  plan?: { itineraries?: Array<{ legs?: Array<{ transitLeg?: boolean }> }> }
}

/**
 * Which plan of the fan-out, if any, came back silent.
 *
 * "Silent" is the exact shape of the 09-21 failure: a transit-bearing
 * combination that answered (no transport error), with NO routing error of its
 * own, and not one transit leg among its itineraries. The routing errors have
 * to be the RAW ones as OTP sent them — `routingQuery`'s `rewritePayload`
 * strips `NO_TRANSIT_CONNECTION` out of the stored response before the reducer
 * ever sees it, so reading them back off the store would turn OTP's own
 * "I found nothing" into an indistinguishable `[]` and diagnose a case that
 * already explained itself.
 *
 * Earliest index wins, so the record names the same call every time a search
 * repeats.
 */
export function pickDiagnosticTarget<T extends AnsweredPlan>(
  plans: T[],
  responses: Array<StoredResponse | null | undefined> | null | undefined,
  rawRoutingErrorCodes: Array<string[] | undefined> | null | undefined
): T | undefined {
  return plans
    .filter((plan) => plan.capBearing)
    .sort((a, b) => a.index - b.index)
    .find((plan) => {
      const response = responses?.[plan.index]
      if (!response || response.error) return false
      const codes = rawRoutingErrorCodes?.[plan.index]
      // undefined = this call never reached rewritePayload, i.e. it errored.
      if (!Array.isArray(codes) || codes.length > 0) return false
      const itineraries = response.plan?.itineraries || []
      return !itineraries.some((itin) =>
        (itin?.legs || []).some((leg) => leg?.transitLeg)
      )
    })
}

/**
 * Should this settled search be diagnosed at all?
 *
 * The "no" list is deliberately the same shape as `shouldWidenThinSearch`'s:
 *  - `transitCount > 0`: some combination did find transit, so nothing about
 *    this search is anomalous — a per-combination miss is ordinary.
 *  - `goModeActive`: a live trip's re-plans run through the same action. An
 *    extra cap-10000 plan on a moving rider's cell link is the load shape
 *    backlog 17.8 is about, and a reroute that finds no transit is a different
 *    question with its own rows.
 *  - `updateSearchInReducer`: field trip appends to one search on purpose.
 *  - `routingType`: PROFILE responses have no `plan.itineraries` to read.
 *  - `replayActive`: a replay serves plans from a fixture; a diagnostic query
 *    is not in it and would resolve to an error, recording a fake failure.
 */
export function shouldDiagnoseMissingTransit({
  goModeActive,
  replayActive,
  routingType,
  transitCount,
  updateSearchInReducer
}: {
  goModeActive?: boolean
  replayActive?: boolean
  routingType?: string | null
  transitCount: number
  updateSearchInReducer?: boolean
}): boolean {
  if (transitCount > 0) return false
  if (goModeActive) return false
  if (replayActive) return false
  if (updateSearchInReducer) return false
  if (routingType && routingType !== 'ITINERARY') return false
  return true
}
