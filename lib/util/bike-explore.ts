/**
 * Calm / Wander bike routing (rider ask, 2026-11-21).
 *
 * OTP plans a bike leg one way: as fast as its safe-streets default allows,
 * timed to reach the stop as the bus does. The rider asked for the opposite
 * question to be askable — "what is the NICEST ride that still catches this
 * bus, and which stop is the nicest one to catch it at?" — with one tap back
 * to the old answer.
 *
 * That question is answered by a second planner, the RunScout bike engine
 * (`~/projects/runscout`, `runscout/bike.py`, `POST /api/bike/access`), which
 * knows two things OTP does not: how stressful each street is (level of
 * traffic stress 1-4 from class, speed, lanes and bike facility) and how
 * pleasant it is (parks, water, trails). It is handed the rider's position and
 * a list of CANDIDATE BOARDINGS — a stop, and how many seconds from now the
 * bus leaves it — and returns, per candidate, a ride in the shape of an OTP
 * leg plus what makes it good.
 *
 * Three modes:
 *  - `direct` — OTP's own leg, untouched. The old version. The engine is never
 *    called.
 *  - `calm`   — lowest-stress streets, at most 20 % + 1 min slower.
 *  - `wander` — spends spare time on parks, water and trails, staying calm; at
 *    most 60 % + 4 min slower, never more than 20 min.
 *
 * The engine keeps a margin at the stop of 3 min + 10 % of the ride (rider's
 * choice, 2026-11-21) and blends back toward the fastest ride as the time to
 * the bus shrinks, so a late rider gets the direct route without asking.
 *
 * This module is the pure half: the wire types, the request, and turning an
 * answer into an access itinerary the existing splicers accept
 * (`spliceAccessOntoItinerary`, `spliceGetOn`). It makes one network call,
 * `fetchBikeExplore`, which never throws: any failure is `null`, and every
 * caller's fallback is the OTP leg it already had.
 */
/* eslint-disable camelcase -- the engine's wire format is snake_case */
import type { Itinerary, Leg } from '@opentripplanner/types'

export type ExploreMode = 'direct' | 'calm' | 'wander'

export const EXPLORE_MODES: ExploreMode[] = ['direct', 'calm', 'wander']

/** localStorage key (via util/safe-storage) for the rider's chosen mode. */
export const EXPLORE_MODE_STORAGE_KEY = 'bikeExploreMode'

/** Same-origin path, proxied by nginx to the engine (127.0.0.1:8787). */
export const BIKE_EXPLORE_API_PATH = '/api/bike/access'

/** The engine answers in well under a second; past this, use OTP's leg. */
export const BIKE_EXPLORE_TIMEOUT_MS = 6000

/**
 * A whole search's candidates in one request: the engine shares work per stop
 * (about 1 s calm, 5-10 s wander for 1,200 candidates), so the batch gets
 * more time than a single question.
 */
export const BIKE_EXPLORE_BATCH_TIMEOUT_MS = 30000

/** The most candidates the engine takes in one request. */
export const BIKE_EXPLORE_MAX_CANDIDATES = 2000

/** The engine's margin rule, mirrored for display: 3 min + 10 % of the ride. */
export const EXPLORE_MARGIN_FIXED_MS = 180000
export const EXPLORE_MARGIN_FRACTION = 0.1

export function normalizeExploreMode(value: unknown): ExploreMode {
  return value === 'calm' || value === 'wander' ? value : 'direct'
}

/** Wait the rider is left with at the stop after a ride of this length. */
export function exploreMarginMs(rideMs: number): number {
  const ride = Number.isFinite(rideMs) && rideMs > 0 ? rideMs : 0
  return EXPLORE_MARGIN_FIXED_MS + EXPLORE_MARGIN_FRACTION * ride
}

interface LatLon {
  lat: number
  lon: number
}

/** One place the rider could board, and when the bus leaves it. */
export interface ExploreCandidate extends LatLon {
  /**
   * Epoch ms the bus leaves this stop; null when nothing is being caught (a
   * bike-only trip), which lifts the deadline but not the mode's own cap.
   */
  busEpoch: number | null
  id: string
  name?: string
}

export interface ExploreRequestInput {
  candidates: ExploreCandidate[]
  /** Ask for the compact answer: rides once, candidates pointing at them. */
  compact?: boolean
  /** Cap, in seconds, on time spent beyond the fastest ride. */
  maxExtraS?: number
  mode: ExploreMode
  /**
   * The moment the ride can start: now for a leave-now search or a live
   * re-plan, the search's own departure time for a planned one.
   */
  nowMs: number
  origin: LatLon
  /** Cruising speed, m/s (the rider's measured speed when Go Mode has one). */
  speed?: number
}

/** Body of POST /api/bike/access. Null when there is nothing valid to ask. */
export function buildExploreRequest(input: ExploreRequestInput): any | null {
  const { candidates, compact, maxExtraS, mode, nowMs, origin, speed } = input
  if (mode === 'direct') return null
  if (!Number.isFinite(origin?.lat) || !Number.isFinite(origin?.lon)) {
    return null
  }
  const stops = (candidates || [])
    .filter((c) => c?.id && Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .slice(0, BIKE_EXPLORE_MAX_CANDIDATES)
    .map((c) => ({
      depart_s:
        c.busEpoch != null && Number.isFinite(c.busEpoch)
          ? Math.round((c.busEpoch - nowMs) / 1000)
          : null,
      id: c.id,
      lat: c.lat,
      lon: c.lon,
      name: c.name || ''
    }))
  if (!stops.length) return null
  const body: any = {
    candidates: stops,
    lat: origin.lat,
    lon: origin.lon,
    mode
  }
  if (compact) body.compact = true
  if (Number.isFinite(speed as number)) {
    body.speed = Math.min(12, Math.max(1, speed as number))
  }
  if (Number.isFinite(maxExtraS as number)) {
    body.max_extra_s = Math.max(0, maxExtraS as number)
  }
  return body
}

/** What the engine says about one stop as a place to wait. */
export interface ExploreStopQuality {
  bench: boolean
  lit: boolean
  /** False when OpenStreetMap has no stop mapped here: amenities unknown. */
  mapped: boolean
  /** 0-1: share of the stop's surroundings that is park or water. */
  nature: number
  /** 0-1. */
  score: number
  shelter: boolean
  station: boolean
  /** 0-1: share of the stop's surroundings beside a busy road. */
  traffic: number
}

/** The engine's answer for one candidate (fields as sent, snake_case). */
export interface ExploreResult {
  /** 0-1 share of ride time on stress 1-2 streets. */
  calm?: number
  composition?: Record<string, number>
  direct?: {
    calm: number
    distance_m: number
    duration_s: number
    leave_in_s: number | null
  }
  distance_m?: number
  duration_s?: number
  feasible: boolean
  id: string
  /** Seconds from the request's `now` to set off; null without a deadline. */
  leave_in_s?: number | null
  leg?: {
    distance: number
    duration: number
    legGeometry: { length: number; points: string }
    mode: 'BICYCLE'
    steps: any[]
  }
  margin_s?: number
  name?: string
  /** Named places the ride passes, in order. */
  places?: string[]
  /** 1 = the mode's full preference, 0 = collapsed to the fastest ride. */
  preference?: number
  reason?: string
  scenic?: number
  /** 0-100, for ranking boardings against each other. */
  score?: number
  stop?: ExploreStopQuality
  stress?: { lts3: number; lts4: number; walk: number }
  /** [[metres, level 0-4], ...] along the ride; 0 = walk the bike. */
  stress_profile?: Array<[number, number]>
  summary?: string
  /** The park or lake the ride detours through, when it does. */
  via?: string | null
}

/** One candidate of a compact answer: a pointer into `rides`. */
interface CompactCandidate {
  [key: string]: any
  direct_leave_in_s?: number | null
  id: string
  ride?: number
}

/**
 * A compact answer's candidates as the flat shape every caller reads: the
 * ride's fields under the candidate's own, `direct.leave_in_s` put back. The
 * rides' heavy fields (leg, profile) are shared by reference, not copied.
 */
function inflateCompact(rides: any[], candidates: CompactCandidate[]) {
  return candidates.map((c) => {
    const ride = Number.isInteger(c?.ride) ? rides[c.ride as number] : null
    if (!ride || typeof ride !== 'object') return c
    const { direct_leave_in_s: directLeave, ride: _index, ...rest } = c
    const out: any = { ...ride, ...rest }
    if (ride.direct) {
      out.direct = { ...ride.direct, leave_in_s: directLeave ?? null }
    }
    return out as ExploreResult
  })
}

export interface ExploreResponse {
  candidates: ExploreResult[]
  mode: ExploreMode
  status: 'ok'
}

/** What an explore-planned bike leg carries so the UI can say why. */
export interface ExploreRide {
  calm: number
  /** Share of time on calm streets on OTP-like fastest ride, for contrast. */
  directCalm: number | null
  directDurationS: number | null
  marginS: number
  mode: ExploreMode
  places: string[]
  preference: number
  score: number
  stop: ExploreStopQuality | null
  /** Candidate id: the stop this ride goes to. */
  stopId: string
  stress: { lts3: number; lts4: number; walk: number } | null
  stressProfile: Array<[number, number]>
  summary: string
  via: string | null
}

/**
 * The feasible candidate to board at: highest score, and between scores
 * within two points of each other the shorter ride (a tie is not worth
 * minutes). Null when the engine found nothing that catches a bus.
 */
export function pickBestExploreResult(
  results: ExploreResult[] | null | undefined
): ExploreResult | null {
  const usable = (results || []).filter(
    (r) => r?.feasible && r.leg && Number.isFinite(r.duration_s as number)
  )
  if (!usable.length) return null
  return usable.reduce((best, r) => {
    const gap = (r.score || 0) - (best.score || 0)
    if (gap > 2) return r
    if (gap < -2) return best
    return (r.duration_s as number) < (best.duration_s as number) ? r : best
  })
}

export interface ExploreAccessInput {
  /**
   * Epoch ms the bus leaves the stop. The ride is timed to END one margin
   * before it — unless `startMs` is given.
   */
  busEpoch: number | null
  from: any
  mode: ExploreMode
  result: ExploreResult
  /**
   * Epoch ms the ride starts, for a rider already moving (Go Mode) or a trip
   * with no bus to catch. Wins over `busEpoch`.
   */
  startMs?: number | null
  to: any
}

/**
 * The engine's ride as an access itinerary: one BICYCLE leg, origin to stop,
 * in the shape OTP returns and the splicers take. Null when the answer has no
 * leg or cannot be timed.
 */
export function exploreAccessItinerary(
  input: ExploreAccessInput
): Itinerary | null {
  const { busEpoch, from, mode, result, startMs, to } = input
  const leg = result?.leg
  const durationS = Number(leg?.duration)
  if (!leg?.legGeometry?.points || !Number.isFinite(durationS)) return null
  const durationMs = durationS * 1000
  let startTime: number
  if (startMs != null && Number.isFinite(startMs)) {
    startTime = startMs
  } else if (busEpoch != null && Number.isFinite(busEpoch)) {
    startTime = busEpoch - exploreMarginMs(durationMs) - durationMs
  } else {
    return null
  }
  const endTime = startTime + durationMs
  const exploreRide: ExploreRide = {
    calm: result.calm ?? 0,
    directCalm: result.direct?.calm ?? null,
    directDurationS: result.direct?.duration_s ?? null,
    marginS: result.margin_s ?? Math.round(exploreMarginMs(durationMs) / 1000),
    mode,
    places: result.places || [],
    preference: result.preference ?? 0,
    score: result.score ?? 0,
    stop: result.stop || null,
    stopId: result.id,
    stress: result.stress || null,
    stressProfile: result.stress_profile || [],
    summary: result.summary || '',
    via: result.via || null
  }
  const bikeLeg: any = {
    distance: leg.distance,
    duration: durationS,
    endTime,
    exploreRide,
    from: { ...from, vertexType: from?.vertexType || 'NORMAL' },
    interlineWithPreviousLeg: false,
    legGeometry: leg.legGeometry,
    mode: 'BICYCLE',
    realTime: false,
    rentedBike: false,
    startTime,
    steps: leg.steps || [],
    to,
    transitLeg: false
  }
  return {
    duration: durationS,
    endTime,
    legs: [bikeLeg as Leg],
    startTime,
    transfers: 0,
    waitingTime: 0,
    walkDistance: leg.distance,
    walkTime: 0
  } as unknown as Itinerary
}

/** The explore metadata of an itinerary's first bike leg, if it has any. */
export function exploreRideOf(
  itinerary: Itinerary | null | undefined
): ExploreRide | null {
  const leg: any = (itinerary?.legs || []).find(
    (l: any) => !l.transitLeg && l.exploreRide
  )
  return leg?.exploreRide || null
}

/**
 * What an itinerary offers the engine: `access` when its FIRST leg is the
 * rider's own bike straight into a transit leg (the ride before the bus),
 * `bike-only` for one bike leg to the destination, else null. A rented bike
 * is never re-routed: the engine assumes the rider's own bike, and a dock is
 * where the ride has to start.
 */
export type ExploreTarget = 'access' | 'bike-only'

export function exploreTargetOf(
  itinerary: Itinerary | null | undefined
): ExploreTarget | null {
  const legs: any[] = (itinerary?.legs as any[]) || []
  const first = legs[0]
  if (!first || first.mode !== 'BICYCLE' || first.rentedBike) return null
  if (first.transitLeg) return null
  if (legs.length === 1) return 'bike-only'
  return legs[1]?.transitLeg ? 'access' : null
}

/**
 * A name for one itinerary of a search that does not depend on where it sits
 * in the list: every leg's mode, trip, times and ends. Explore variants are
 * stored under it, so a response that arrives late (and moves positions while
 * the search is still pending) cannot hand one itinerary's ride to another.
 */
export function exploreItineraryKey(
  itinerary: Itinerary | null | undefined
): string {
  const place = (p: any) =>
    p?.stopId ||
    p?.stop?.gtfsId ||
    (Number.isFinite(p?.lat) ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : '')
  return ((itinerary?.legs as any[]) || [])
    .map(
      (leg) =>
        `${leg.mode}:${leg.trip?.gtfsId || ''}:${leg.startTime}:${
          leg.endTime
        }:${place(leg.from)}>${place(leg.to)}`
    )
    .join('|')
}

/** Where one itinerary's explore lookup stands, for one search and mode. */
export interface ExploreEntry {
  /**
   * `pending` while asked; `done` with a `variant` when the engine's ride
   * replaces OTP's; `none` when it does not (engine unreachable, nothing
   * feasible, could not be spliced) — that itinerary keeps OTP's leg.
   */
  status: 'pending' | 'done' | 'none'
  variant?: Itinerary
}

export type ExploreEntries = Record<string, ExploreEntry>

/**
 * The list as the rider sees it with a mode on: each itinerary that has an
 * explore variant replaced by it, AT THE SAME POSITION (index kept — 23.5's
 * positional indexes, the URL's ui_activeItinerary and the merge all key on
 * it). Direct, or nothing to substitute, returns the SAME array: the old
 * version, untouched.
 *
 * `finish` re-derives what the list adds to each itinerary (sorting costs)
 * for a substituted one.
 */
export function applyExploreVariants<T extends Itinerary & { index?: number }>(
  itineraries: T[],
  mode: ExploreMode,
  entries: ExploreEntries | null | undefined,
  finish: (itinerary: any) => any = (itinerary) => itinerary
): T[] {
  if (mode === 'direct' || !entries || !itineraries?.length) {
    return itineraries
  }
  let changed = false
  const out = itineraries.map((itinerary) => {
    const variant = entries[exploreItineraryKey(itinerary)]?.variant
    if (!variant) return itinerary
    changed = true
    return finish({ ...variant, index: itinerary.index })
  })
  return changed ? out : itineraries
}

/**
 * A result row (as the list renders it) with every explore ride in it put
 * back to OTP's itinerary at the same index — for the lookups that BUILD new
 * itineraries from a row ("Other stops", the route-row timetable). They
 * append what they build to the search's OTP responses, and a template with
 * an explore leg in it would put that leg into OTP's answer, where Direct
 * would then show it. A row with no explore ride comes back as the same
 * object.
 */
export function otpRowOf<T extends Record<string, any>>(
  row: T,
  otpItineraries: Array<Itinerary & { index?: number }> | null | undefined
): T {
  if (!row || !otpItineraries?.length) return row
  const back = (run: any) =>
    run && exploreRideOf(run) && typeof run.index === 'number'
      ? otpItineraries[run.index] || run
      : run
  const hasExplore =
    !!exploreRideOf(row as any) ||
    (row.sameShapeVariants || []).some((v: any) => exploreRideOf(v)) ||
    (row.allStartTimes || []).some((t: any) => exploreRideOf(t?.itinerary))
  if (!hasExplore) return row
  const out: any = { ...back(row) }
  if (row.allStartTimes) {
    out.allStartTimes = row.allStartTimes.map((t: any) => {
      const itinerary = back(t?.itinerary)
      return itinerary === t?.itinerary
        ? t
        : { ...t, itinerary, legs: itinerary.legs }
    })
  }
  if (row.sameShapeVariants) {
    out.sameShapeVariants = row.sameShapeVariants.map(back)
  }
  return out as T
}

/**
 * Rider's decision 3 (2026-11-21), "other routes too": among the options that
 * arrive no later than the earliest one (same minute, 0 min tolerance), the
 * explore ride the engine scores highest. Returns its `index`, or null when
 * fewer than two options arrive that early or none of them is an explore
 * ride — with one option there is nothing to prefer it over.
 */
export function nicestExploreIndex(
  itineraries: Array<Itinerary & { index?: number }> | null | undefined
): number | null {
  const list = (itineraries || []).filter(
    (itin) => itin && Number.isFinite(Number(itin.endTime))
  )
  if (list.length < 2) return null
  const minute = (itin: Itinerary) => Math.floor(Number(itin.endTime) / 60000)
  const earliest = Math.min(...list.map(minute))
  const contenders = list.filter((itin) => minute(itin) <= earliest)
  if (contenders.length < 2) return null
  let bestIndex: number | null = null
  let bestScore = -Infinity
  contenders.forEach((itin) => {
    const ride = exploreRideOf(itin)
    if (!ride || typeof itin.index !== 'number') return
    if (ride.score > bestScore) {
      bestIndex = itin.index
      bestScore = ride.score
    }
  })
  return bestIndex
}

/** How a stretch of the ride reads in the stress strip. */
export type StressCategory = 'calm' | 'busy' | 'heavy' | 'walk'

/** Engine level → strip category: 1-2 calm, 3 busy, 4 heavy, 0 walk the bike. */
export function stressCategory(level: number): StressCategory {
  if (level === 0) return 'walk'
  if (level >= 4) return 'heavy'
  if (level === 3) return 'busy'
  return 'calm'
}

export interface StressSegment {
  category: StressCategory
  metres: number
  /** 0-1 of the whole ride. */
  share: number
}

/**
 * The stress profile as strip segments: neighbours in the same category
 * joined (a profile has dozens of 4-16 m stretches that would each be a
 * sliver), each with its share of the ride's length.
 */
export function stressStripSegments(
  profile: Array<[number, number]> | null | undefined
): StressSegment[] {
  const merged: Array<{ category: StressCategory; metres: number }> = []
  ;(profile || []).forEach((entry) => {
    const metres = Number(entry?.[0])
    if (!Number.isFinite(metres) || metres <= 0) return
    const category = stressCategory(Number(entry[1]))
    const last = merged[merged.length - 1]
    if (last && last.category === category) last.metres += metres
    else merged.push({ category, metres })
  })
  const total = merged.reduce((sum, s) => sum + s.metres, 0)
  if (!total) return []
  return merged.map((s) => ({ ...s, share: s.metres / total }))
}

/** Share of the ride's length in each category, 0-1. */
export function stressShares(
  segments: StressSegment[]
): Record<StressCategory, number> {
  const out: Record<StressCategory, number> = {
    busy: 0,
    calm: 0,
    heavy: 0,
    walk: 0
  }
  segments.forEach((s) => {
    out[s.category] += s.share
  })
  return out
}

/**
 * When the DIRECT ride would leave, by the same margin rule: the bus's time
 * at the stop, less 3 min + 10 % of the direct ride, less the ride. Null for
 * a trip with no bus (bike-only: both rides leave together) or no direct
 * time.
 */
export function exploreDirectLeaveMs(
  itinerary: Itinerary | null | undefined
): number | null {
  const ride = exploreRideOf(itinerary)
  const directS = ride?.directDurationS
  if (ride == null || directS == null || !Number.isFinite(directS)) return null
  const bus: any = (itinerary?.legs || []).find((l: any) => l.transitLeg)
  const busEpoch = Number(bus?.startTime)
  if (!Number.isFinite(busEpoch)) return null
  const directMs = directS * 1000
  return busEpoch - exploreMarginMs(directMs) - directMs
}

/**
 * Ask the engine. Resolves to the answer, or null on ANY failure — offline,
 * timeout, a 4xx/5xx (503 = no bike map covers here), a malformed body. The
 * caller keeps the OTP leg it already has.
 */
export async function fetchBikeExplore(
  url: string,
  body: any,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<ExploreResponse | null> {
  if (!url || !body) return null
  const doFetch =
    options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null)
  if (!doFetch) return null
  const controller =
    typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = setTimeout(
    () => controller?.abort(),
    options.timeoutMs ?? BIKE_EXPLORE_TIMEOUT_MS
  )
  try {
    const res = await doFetch(url, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: controller?.signal
    })
    if (!res.ok) return null
    const json = await res.json()
    if (json?.status !== 'ok' || !Array.isArray(json.candidates)) return null
    if (Array.isArray(json.rides)) {
      return {
        ...json,
        candidates: inflateCompact(json.rides, json.candidates)
      } as ExploreResponse
    }
    return json as ExploreResponse
  } catch (e) {
    return null
  } finally {
    clearTimeout(timer)
  }
}
