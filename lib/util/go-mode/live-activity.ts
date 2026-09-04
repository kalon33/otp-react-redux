import type { Itinerary, Leg } from '@opentripplanner/types'

import { buildLiveItinerary, legAlight } from './live-itinerary'
import {
  endLiveActivity,
  hasNativeLiveActivity,
  LiveActivityPayload,
  startLiveActivity,
  updateLiveActivity
} from './native-live-activity'
import {
  findBoardLegIndex,
  getEffectiveBoardTimeMs,
  itineraryArrivalMs
} from './notification-service'
import type { LiveLegTime, RidingState } from './types'
import type { TripProgress } from './progress-calculator'

/**
 * live-activity.ts — what the Go Mode lock-screen card says, and how often it
 * is allowed to say it. Backlog 8.10; the rider's ask, 2026-09-01 08:28: *"an
 * active widget that stays on lock screen when in go mode? Showing next leg and
 * arrival time?"*
 *
 * Two jobs, kept apart so both can be tested without a phone:
 *
 *   buildLiveActivityContent()  — pure. Go Mode state in, card content out.
 *   syncLiveActivity()          — the throttle and the start/update/end
 *                                 lifecycle, over native-live-activity.ts.
 *
 * THE ARRIVAL NUMBER IS THE ITINERARY'S, NOT THE CURRENT LEG'S. This is the
 * 2026-08-31 ride-3 / 2026-09-01 ride-1 defect, and it is the whole reason the
 * arrival is computed here rather than read off `progress`: the aboard re-plan's
 * "Trip updated" copy took its arrival from `legs[0]` — the bus the rider was
 * sitting on — and announced 8:45 AM, the moment they got OFF that bus, while
 * the itinerary it had just installed ended at 08:51:45 and the trip sheet on
 * the same screen said so. Two answers to one question, 6m41s apart, on one
 * tick. A lock-screen card is the *most* visible place that could happen, so
 * the number here is the last LIVE leg's end — the live itinerary the trip
 * sheet renders, not the plan frozen at planning time.
 *
 * THE BOARDING NUMBER IS getEffectiveBoardTimeMs's. Not `leg.startTime`, not
 * `progress.effectiveDepartureMs`: the same function classifyMissedBus asks, so
 * the card and the missed-bus logic can never disagree about when the bus goes
 * (backlog 8.2). Its rank order — the board field's OWN realtime epoch, then a
 * rider-selected departure on the same run, then the plan — is carried through
 * unchanged, including the rule that an override naming a DIFFERENT run is not
 * an answer to this question.
 *
 * COPY. The rider's standing rule: only the numbers they act on. No coaching
 * phrases, no clock times spelled into sentences. The card carries a mode
 * symbol, a route, a stop, and two times; the widget renders both times as
 * self-ticking SwiftUI text, so they stay right between updates.
 */

/**
 * The floor between content-identical updates. ActivityKit rate-limits
 * updates per app and drops the excess with no error, so a per-GPS-tick
 * cadence (up to 1 Hz on this app) would spend the whole budget in the first
 * mile and then silently stop working for the rest of the ride. A minute is
 * enough: the two times on the card tick themselves in SwiftUI, so between
 * updates the card is still counting down correctly — an update only has to
 * carry a CHANGED prediction.
 */
export const LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 60000

const TRANSIT_MODES = ['BUS', 'RAIL', 'SUBWAY', 'TRAM', 'FERRY']

function isTransitMode(mode: string | undefined): boolean {
  return mode != null && TRANSIT_MODES.includes(mode)
}

/** The mode word for a leg with no route: what the rider is doing right now. */
function modeWord(mode: string | undefined): string {
  switch (mode) {
    case 'BICYCLE':
      return 'Bike'
    case 'CAR':
      return 'Drive'
    case 'SCOOTER':
      return 'Scooter'
    case 'WALK':
      return 'Walk'
    default:
      return 'Go'
  }
}

/** How the app names a route everywhere else: short name, else long, else mode. */
function routeName(leg: Leg | undefined): string {
  const anyLeg = leg as any
  return anyLeg?.routeShortName || anyLeg?.routeLongName || modeWord(leg?.mode)
}

function placeName(place: any, fallback: string): string {
  const name = place?.name
  return typeof name === 'string' && name.length > 0 ? name : fallback
}

export interface LiveActivityInput {
  activeItinerary: Itinerary | null
  /** Epoch ms the trip was latched as complete, or null while en route. */
  arrivedAt: number | null
  departureOverride: number | null
  liveLegTimes: Record<number, LiveLegTime>
  progress: TripProgress | null
  riding: RidingState | null
  /** Identifies the card; the controller supplies it, one per Go Mode session. */
  tripId: string
}

/**
 * The card's content for this moment, or null when there is no trip to draw.
 *
 * Pure: no clock, no bridge, no store. Everything time-dependent it needs is
 * already in the state it is handed.
 */
export function buildLiveActivityContent(
  input: LiveActivityInput
): LiveActivityPayload | null {
  const {
    activeItinerary,
    arrivedAt,
    departureOverride,
    liveLegTimes,
    progress,
    riding,
    tripId
  } = input
  const legs: Leg[] = (activeItinerary?.legs as Leg[]) || []
  if (legs.length === 0) return null

  // --- the arrival: the itinerary's end, with the live delays folded in -----
  // buildLiveItinerary is what the trip sheet renders, so the card and the
  // sheet quote the same number by construction. It shifts LEG times and
  // leaves the itinerary's own top-level `endTime` at its planning value —
  // which is exactly why the last leg's end is read here and
  // itineraryArrivalMs (which prefers `endTime`) is only the fallback for an
  // itinerary that has no usable legs at all.
  const live = buildLiveItinerary(activeItinerary as Itinerary, liveLegTimes)
  const liveLegs: Leg[] = (live?.legs as Leg[]) || []
  const lastLiveEnd = Number(liveLegs[liveLegs.length - 1]?.endTime)
  const arrivalEpochMs = Number.isFinite(lastLiveEnd)
    ? lastLiveEnd
    : itineraryArrivalMs(activeItinerary)

  // Realtime iff the LAST transit leg's alight is realtime — that leg is what
  // the arrival actually rests on; a schedule-only alight followed by a walk
  // makes the arrival a schedule number however live the earlier legs were.
  let arrivalIsRealtime = false
  for (let i = legs.length - 1; i >= 0; i--) {
    if (!isTransitMode(legs[i].mode)) continue
    arrivalIsRealtime = legAlight(i, legs[i], liveLegTimes).realtime === true
    break
  }

  const destinationName = placeName(
    (legs[legs.length - 1] as any)?.to,
    'your destination'
  )

  // --- arrived: one last card, then it comes down --------------------------
  if (arrivedAt != null) {
    return {
      arrivalEpochMs: arrivedAt,
      arrivalIsRealtime: false,
      boardEpochMs: null,
      boardIsRealtime: false,
      destinationName,
      legDetail: '',
      legHeadline: destinationName,
      legMode: 'WALK',
      phase: 'arrived',
      tripId
    }
  }

  const rawIndex = progress?.currentLegIndex ?? 0
  const currentLegIndex = Math.max(0, Math.min(rawIndex, legs.length - 1))
  const currentLeg = legs[currentLegIndex]

  // --- aboard: the card is about getting OFF -------------------------------
  // `riding` is the durable "rider is on this vehicle" fact, and it is paired
  // with the current leg actually being a transit leg: the fact survives
  // itinerary swaps (deliberately — see reducers/go-mode), so on its own it
  // would still claim the rider was on a bus during the walk that follows.
  if (riding != null && isTransitMode(currentLeg?.mode)) {
    return {
      arrivalEpochMs,
      arrivalIsRealtime,
      // Aboard there is no boarding left to make, and a time here would be a
      // number about something already done.
      boardEpochMs: null,
      boardIsRealtime: false,
      destinationName,
      legDetail: placeName((currentLeg as any)?.to, 'your stop'),
      legHeadline: routeName(currentLeg),
      legMode: currentLeg.mode,
      phase: 'riding',
      tripId
    }
  }

  // --- a boarding still ahead ---------------------------------------------
  const boardLegIndex = findBoardLegIndex(legs, currentLegIndex)
  if (boardLegIndex >= 0) {
    const boardLeg = legs[boardLegIndex]
    const board = getEffectiveBoardTimeMs(
      boardLeg,
      liveLegTimes[boardLegIndex],
      // A rider-selected later departure only applies to the boarding coming
      // up next — the same window classifyMissedBus uses, so the two cannot
      // answer differently.
      boardLegIndex === currentLegIndex || boardLegIndex === currentLegIndex + 1
        ? departureOverride
        : null
    )
    return {
      arrivalEpochMs,
      arrivalIsRealtime,
      boardEpochMs: Number.isFinite(board.ms) ? board.ms : null,
      boardIsRealtime: board.realtime,
      destinationName,
      legDetail: placeName((boardLeg as any)?.from, 'your stop'),
      legHeadline: routeName(boardLeg),
      legMode: boardLeg.mode,
      phase: 'toStop',
      tripId
    }
  }

  // --- no transit left: walking or riding a bike to the destination --------
  return {
    arrivalEpochMs,
    arrivalIsRealtime,
    boardEpochMs: null,
    boardIsRealtime: false,
    destinationName,
    legDetail: destinationName,
    legHeadline: modeWord(currentLeg?.mode),
    legMode: currentLeg?.mode ?? 'WALK',
    phase: 'walking',
    tripId
  }
}

/**
 * What the rider can SEE. Two payloads with the same key differ only in their
 * times, and the widget's times tick themselves — so an update carrying only a
 * changed key is the one worth spending the budget on immediately.
 */
function contentKey(payload: LiveActivityPayload): string {
  return [
    payload.phase,
    payload.legMode,
    payload.legHeadline,
    payload.legDetail
  ].join('|')
}

/**
 * Is an update due? Yes on the first one, yes whenever the visible content
 * changes (a leg change, boarding, alighting, arrival — every one of those
 * moves phase / headline / detail), and otherwise only once the interval has
 * passed.
 *
 * Exported for its own tests: the throttle is the part that decides whether
 * this feature works for a whole ride or stops working after ten minutes.
 */
export function liveActivityUpdateDue(
  previous: LiveActivityPayload | null,
  next: LiveActivityPayload,
  nowMs: number,
  lastSentAtMs: number
): boolean {
  if (previous == null) return true
  if (contentKey(previous) !== contentKey(next)) return true
  return nowMs - lastSentAtMs >= LIVE_ACTIVITY_UPDATE_INTERVAL_MS
}

interface ControllerState {
  lastPayload: LiveActivityPayload
  lastSentAtMs: number
  tripId: string
}

/**
 * Module-private, exactly like the notification latches in
 * notification-service: there is one lock screen and one trip, and putting
 * this in the store would mean a reducer case, a persisted field and a slice
 * of state nothing renders.
 */
let controller: ControllerState | null = null

/** True while a card is believed to be up. */
export function liveActivityIsRunning(): boolean {
  return controller != null
}

/**
 * Bring the card into line with the trip. Safe to call on every position tick
 * — the throttle is the whole point — and a no-op in any shell without the
 * plugin, which is what makes an OTA carrying this safe on today's phone.
 *
 * Starts the card the first time it is called for a trip (the START_GO_MODE /
 * RESUME_GO_MODE path calls it once immediately, so the card is up before the
 * first GPS fix lands), updates it when {@link liveActivityUpdateDue} says so,
 * and ends it on arrival.
 */
export async function syncLiveActivity(
  input: LiveActivityInput,
  nowMs: number
): Promise<void> {
  if (!hasNativeLiveActivity()) return
  const payload = buildLiveActivityContent(input)
  if (payload == null) return

  // A different trip means a different card. The controller's id is minted
  // per Go Mode session, so this only fires when the session itself changed
  // under a running activity (a resume after a start that was never ended).
  if (controller != null && controller.tripId !== payload.tripId) {
    await endLiveActivity(undefined, { immediate: true })
    controller = null
  }

  if (controller == null) {
    // Never open a card for a trip that is already over.
    if (payload.phase === 'arrived') return
    const started = await startLiveActivity(payload)
    if (!started) return
    controller = {
      lastPayload: payload,
      lastSentAtMs: nowMs,
      tripId: payload.tripId
    }
    return
  }

  if (payload.phase === 'arrived') {
    controller = null
    // The arrival is the one thing worth leaving on a lock screen after the
    // trip: it comes down on the plugin's own dismissal timer.
    await endLiveActivity(payload)
    return
  }

  if (
    !liveActivityUpdateDue(
      controller.lastPayload,
      payload,
      nowMs,
      controller.lastSentAtMs
    )
  ) {
    return
  }
  controller.lastPayload = payload
  controller.lastSentAtMs = nowMs
  await updateLiveActivity(payload)
}

/**
 * Take the card down because the SESSION ended — the rider exited Go Mode, or
 * a new trip is replacing this one. Immediate: there is nothing left to read.
 */
export async function stopLiveActivity(): Promise<void> {
  if (controller == null) return
  controller = null
  await endLiveActivity(undefined, { immediate: true })
}

/** Test seam. There is no other way to clear module-private latches. */
export function __resetLiveActivity(): void {
  controller = null
}
