import type { Leg } from '@opentripplanner/types'

import { asContinuation, formatCueDistance } from './turn-by-turn'
import {
  calculateDistance,
  MATCH_CORRIDOR_TRANSIT_M
} from './position-matching'
import { hasArrivedAtDestination } from './progress-calculator'
import {
  stopsAheadFromNextStopId,
  VEHICLE_AT_BOARD_STOP_M,
  VEHICLE_RECORD_STALE_SEC
} from './transit-trust'
import type { TripProgress } from './progress-calculator'

export type NotificationType =
  | 'APPROACH_STOP'
  | 'ARRIVING_STOP'
  // The rider's own bus closing on their boarding stop while they are still on
  // the access leg — the thing they cannot see from the pavement and asked for
  // by name mid-ride on 2026-08-27. Raised by checkBoardVehicleApproach.
  | 'BOARD_BUS_APPROACHING'
  | 'BOARD_BUS_ARRIVING'
  | 'UPCOMING_TURN'
  | 'TURN_ALERT'
  | 'LEG_TRANSITION'
  | 'DELAY_ALERT'
  | 'ROUTE_DEVIATION'
  | 'CONNECTION_WARNING'
  | 'LEAVE_SOON'
  | 'MISSED_BUS'
  | 'TRIP_COMPLETE'
  | 'TRIP_UPDATED'
  // The bus being travelled toward has moved ≥2 min from the estimate in force
  // when the boarding became current. Raised by departure-drift.ts, which owns
  // the baseline state a check function here could not hold.
  | 'DEPARTURE_CHANGED'
  // Re-planning has stopped getting the rider closer to the destination — the
  // last stretch is not in the street graph. Raised by the quiet access-leg
  // re-plan off destination-progress.ts, which owns the across-replans state.
  | 'DESTINATION_UNREACHABLE'

export interface NotificationConfig {
  enabled: boolean
  soundEnabled: boolean
  vibrationEnabled: boolean
}

export interface NotificationEvent {
  id: string
  message: string
  priority: 'low' | 'medium' | 'high'
  timestamp: Date
  title: string
  type: NotificationType
}

// Notification types that warrant proactively offering a re-route.
const AUTO_REROUTE_TRIGGER_TYPES: NotificationType[] = [
  'CONNECTION_WARNING',
  'ROUTE_DEVIATION'
]

/**
 * Whether to kick off an automatic re-route suggestion this update: a
 * connection-risk or off-route notification just fired and no re-route is
 * already in progress or awaiting the rider's decision (status must be 'idle').
 * The suggestion is surfaced as a Switch/Keep card — never an automatic swap.
 */
export function shouldAutoReroute(
  notifications: NotificationEvent[],
  reRouteStatus: string
): boolean {
  // 'none' is a settled failed/empty attempt — retryable, like the missed-bus
  // and boarded-earlier paths treat it. Nothing ever resets 'none' back to
  // 'idle', so requiring exactly 'idle' let one empty reroute anywhere in a
  // ride permanently kill every later deviation response (7/22: the bike leg
  // stayed un-replanned all evening).
  if (reRouteStatus !== 'idle' && reRouteStatus !== 'none') return false
  return notifications.some((n) => AUTO_REROUTE_TRIGGER_TYPES.includes(n.type))
}

/**
 * Generate unique ID for notification to prevent duplicates
 */
function generateNotificationId(
  type: NotificationType,
  context: string
): string {
  return `${type}_${context}_${Date.now()}`
}

/**
 * Check if notification was recently sent to prevent spam
 */
export function wasRecentlySent(
  notificationId: string,
  sentNotifications: string[],
  timeWindowMs = 60000
): boolean {
  // Extract timestamp from notification ID
  const parts = notificationId.split('_')
  const timestamp = parseInt(parts[parts.length - 1], 10)

  if (isNaN(timestamp)) return false

  const now = Date.now()

  // Check if this type/context was sent recently
  const similarNotifications = sentNotifications.filter((id) => {
    const idParts = id.split('_')
    const idTimestamp = parseInt(idParts[idParts.length - 1], 10)

    if (isNaN(idTimestamp)) return false

    // Same type and context
    return (
      id.startsWith(parts.slice(0, -1).join('_')) &&
      now - idTimestamp < timeWindowMs
    )
  })

  return similarNotifications.length > 0
}

/**
 * Trigger device vibration if supported and enabled
 */
export function triggerVibration(
  pattern: number | number[],
  config: NotificationConfig
): void {
  if (!config.vibrationEnabled) return

  if ('vibrate' in navigator) {
    navigator.vibrate(pattern)
  }
}

// The rider gets exactly two alerts before their exit: a heads-up with time to
// gather their things, and one at the door. Both are TIME-based. The stop-count
// triggers these replace (`stopsRemaining === 2` / `=== 1`) fired on a *level*
// with the default 60 s dedup window — and stopsRemaining sits at 1 for the
// whole final inter-stop segment, so the "prepare to exit" alert re-fired every
// minute and buzzed the phone each time (7/22 ride: "insane how many
// notifications I'm getting for last stop"). Level + short window can only ever
// mean repeats; the fix is an edge, deduped per leg for the whole leg.
const ALIGHT_PREPARE_SECONDS = 120
const ALIGHT_ACT_SECONDS = 30
// At the very end a stale prediction can read minutes out while the bus is
// visibly at the kerb — GPS proximity to the alight stop settles it.
const ALIGHT_ACT_METRES = 200
// One firing per stage per leg: far longer than any single transit leg's
// approach, so neither stage can repeat.
const ALIGHT_DEDUP_MS = 30 * 60 * 1000

/** What the alight alerts need beyond `progress`, measured in the action layer. */
export interface AlightContext {
  /** Metres from the rider's GPS fix to the leg's alight stop, if known. */
  distanceMetres: number | null
  /** Seconds until the vehicle reaches the alight stop (live figure preferred). */
  etaSeconds: number | null
}

/**
 * The two — and only two — alerts before the rider's stop.
 *
 * `prepare` at ~2 minutes out, `act` immediately before disembarking. Each is
 * keyed to the leg's identity and stage, never to a stop name or a live number,
 * so a value that lingers in range cannot re-trigger it.
 */
export function checkAlightAlerts(
  progress: TripProgress,
  currentLeg: Leg,
  alight: AlightContext,
  sentNotifications: string[]
): NotificationEvent | null {
  if (!isTransitMode(currentLeg.mode)) return null

  const { distanceMetres, etaSeconds } = alight
  // The proximity trigger is gated on being past the middle of the leg: a route
  // that loops back can pass within 200 m of the exit stop early on, and that
  // must not spend the rider's one door alert.
  const closeOnTheGround =
    distanceMetres != null &&
    distanceMetres <= ALIGHT_ACT_METRES &&
    (progress.currentLegProgress ?? 0) >= 50
  const nearly =
    (etaSeconds != null && etaSeconds <= ALIGHT_ACT_SECONDS) || closeOnTheGround
  const soon = etaSeconds != null && etaSeconds <= ALIGHT_PREPARE_SECONDS

  if (!nearly && !soon) return null
  const stage = nearly ? 'act' : 'prepare'

  const stopName = currentLeg.to?.name || 'your stop'
  // Keyed on the EXIT STOP, not the leg: an auto-update mid-ride (a missed-bus
  // swap, a reroute) hands back a new itinerary whose legs have new identities,
  // and keying on those let the same stop alert all over again. What the rider
  // counts is buzzes about their stop.
  const stopKey = (currentLeg.to as any)?.stop?.gtfsId || stopName
  const id = generateNotificationId(
    stage === 'act' ? 'ARRIVING_STOP' : 'APPROACH_STOP',
    `${stopKey}_${stage}`
  )
  if (wasRecentlySent(id, sentNotifications, ALIGHT_DEDUP_MS)) return null
  return stage === 'act'
    ? {
        id,
        message: `Prepare to exit at ${stopName}`,
        priority: 'high',
        timestamp: new Date(),
        title: 'Next Stop: Your Stop!',
        type: 'ARRIVING_STOP'
      }
    : {
        id,
        message: `Get ready! Your stop (${stopName}) is about 2 minutes away.`,
        priority: 'high',
        timestamp: new Date(),
        title: 'Approaching Your Stop',
        type: 'APPROACH_STOP'
      }
}

// The board-vehicle pair mirrors the alight pair above, from the other side of
// the boarding: while the rider walks or bikes toward their stop, their own
// bus's feed record — and nothing else — drives a heads-up and an at-the-stop
// alert. Stage 1 fires when the live board prediction is inside
// BOARD_APPROACH_SECONDS or the bus is inside BOARD_APPROACH_METRES of the
// stop; stage 2 when the bus's own next stop IS the boarding stop or it is
// within BOARD_ARRIVE_METRES (the same figure classifyMissedBus uses for "the
// bus is at the stop", so the two can never tell contradictory stories).
export const BOARD_APPROACH_SECONDS = 240
export const BOARD_APPROACH_METRES = 1500
export const BOARD_ARRIVE_METRES = VEHICLE_AT_BOARD_STOP_M
// One firing per stage per boarding; longer than any plausible approach.
const BOARD_DEDUP_MS = 30 * 60 * 1000

/** What the board-vehicle alerts need, measured in the action layer. */
export interface BoardVehicleContext {
  /** The live (realtime-flagged) board prediction for the boarding leg. */
  liveBoardEpochMs: number | null
  nowMs: number
  /** The PLANNED trip's own vehicle record — tripId-exact, never any bus of the route. */
  vehicle: {
    ageSec: number | null
    distanceToBoardStopM: number | null
    nextStopId: string | null
  } | null
}

/**
 * "Your bus is coming" while the rider is still making their way to the stop.
 *
 * Rider-requested from the kerb on 2026-08-27 (the 13:44 ride note). Real data
 * only: both stages require a fresh feed record of the planned trip's own
 * vehicle — a schedule time with no vehicle behind it fires nothing, and a
 * vehicle already past the boarding stop is MISSED_BUS's story, not this one's.
 */
export function checkBoardVehicleApproach(
  boardLeg: Leg,
  ctx: BoardVehicleContext,
  sentNotifications: string[]
): NotificationEvent | null {
  const { liveBoardEpochMs, nowMs, vehicle } = ctx
  if (!vehicle) return null
  if (vehicle.ageSec != null && vehicle.ageSec > VEHICLE_RECORD_STALE_SEC) {
    return null
  }

  const boardStopId = (boardLeg.from as any)?.stop?.gtfsId ?? null
  // A vehicle whose own next stop is one of this leg's stops BEYOND the
  // boarding stop has been and gone. Say nothing — a "your bus is arriving"
  // for a bus pulling away would be worse than silence.
  if (
    vehicle.nextStopId != null &&
    vehicle.nextStopId !== boardStopId &&
    stopsAheadFromNextStopId(boardLeg, vehicle.nextStopId)
  ) {
    return null
  }

  const atStop =
    (boardStopId != null && vehicle.nextStopId === boardStopId) ||
    (vehicle.distanceToBoardStopM != null &&
      vehicle.distanceToBoardStopM <= BOARD_ARRIVE_METRES)
  // A live prediction already in the past with a fresh not-yet-arrived vehicle
  // record means "late but coming" — still worth the heads-up.
  const comingSoon =
    (liveBoardEpochMs != null &&
      liveBoardEpochMs - nowMs <= BOARD_APPROACH_SECONDS * 1000) ||
    (vehicle.distanceToBoardStopM != null &&
      vehicle.distanceToBoardStopM <= BOARD_APPROACH_METRES)
  if (!atStop && !comingSoon) return null

  const stage = atStop ? 'arriving' : 'approaching'
  const routeName =
    (boardLeg as any).routeShortName ||
    (boardLeg as any).routeLongName ||
    'Your bus'
  const stopName = boardLeg.from?.name || 'your stop'
  // Keyed on stop AND trip: a re-plan onto a later run is a different bus and
  // must re-arm, while an itinerary swap that keeps the trip stays deduped —
  // the reducer's swap-exemption list preserves these ids for that reason.
  const stopKey = boardStopId || stopName
  const tripKey =
    (boardLeg as any).trip?.gtfsId || (boardLeg as any).tripId || 'plan'
  const id = generateNotificationId(
    stage === 'arriving' ? 'BOARD_BUS_ARRIVING' : 'BOARD_BUS_APPROACHING',
    `${stopKey}_${tripKey}_${stage}`
  )
  if (wasRecentlySent(id, sentNotifications, BOARD_DEDUP_MS)) return null
  return stage === 'arriving'
    ? {
        id,
        message: `${routeName} is arriving at ${stopName}`,
        priority: 'high',
        timestamp: new Date(),
        title: 'Your Bus Is Here',
        type: 'BOARD_BUS_ARRIVING'
      }
    : {
        id,
        message: `${routeName} is a few minutes from ${stopName}`,
        priority: 'high',
        timestamp: new Date(),
        title: 'Your Bus Is Coming',
        type: 'BOARD_BUS_APPROACHING'
      }
}

// Lead distances for turn cues, in metres. A cyclist covers 50 m in about 8
// seconds, so the walking numbers this used to carry arrived far too late to
// act on; these give a bike roughly the same *time* to react that a walker gets.
const BIKE_CUE_DISTANCES = { act: 30, prepare: 120 }
const WALK_CUE_DISTANCES = { act: 15, prepare: 40 }

// Below this ground speed the rider is not travelling: a parked phone's GPS
// reads 0–0.6 m/s of pure noise, while a slow walker is already at 1.2 m/s.
export const MIN_ANNOUNCE_SPEED_MPS = 0.7
// Consecutive slow ticks before turn cues are held. A leg starts pre-charged at
// this count — Go Mode is tapped standing still (on 7/31 the first push went out
// in the same second as START_GO_MODE) so a rider never yet observed moving is
// parked from tick one — while a rider who WAS moving keeps this many ticks of
// grace, enough that a red light or a kerb pause never costs them a cue.
export const STATIONARY_HOLD_TICKS = 3

interface TurnAnnounceState {
  /** `${cue.index}_${stage}` for every cue already announced on this leg. */
  announced: Set<string>
  /** Consecutive ticks whose reported speed was below MIN_ANNOUNCE_SPEED_MPS. */
  slowTicks: number
}

// Per-leg turn state, keyed like cueCache/cursorCache in turn-by-turn.ts: the
// leg object is stable for the life of an itinerary (handlePositionUpdate reads
// `goMode.activeItinerary.legs[i]` straight from redux — never a per-tick clone;
// buildLiveItinerary only ever runs in TripSheet), an itinerary swap hands back
// new leg objects and so a fresh latch, and the whole map is collectable once
// the trip ends.
//
// Why it exists: 7/31 (session ms96ka9s-wc8j1u) the rider stood at the origin 21
// minutes early — 335 GPS fixes inside a 7 m circle — and got the identical
// "Turn right on Village Lane" TURN_ALERT pushed to phone and watch 14 times in
// 7 minutes, every 30.5 s. `wasRecentlySent` is a rate limiter, not a latch: it
// only remembers the last 30 s, so a cue that stays current re-arms forever (and
// `sentNotifications` is a rolling 50-entry list that evicts the evidence
// anyway). The rider: "I specifically asked for notifications to be once".
let turnState = new WeakMap<Leg, TurnAnnounceState>()

function turnStateFor(leg: Leg): TurnAnnounceState {
  let state = turnState.get(leg)
  if (!state) {
    state = { announced: new Set<string>(), slowTicks: STATIONARY_HOLD_TICKS }
    turnState.set(leg, state)
  }
  return state
}

/**
 * Drop every leg's announcement latch and speed history. Test-only: production
 * lifetime is the leg object itself (new itinerary ⇒ new legs ⇒ clean state),
 * but unit tests reuse one leg object across cases.
 */
export function resetTurnAnnouncements(): void {
  turnState = new WeakMap<Leg, TurnAnnounceState>()
}

// Speed-scaled leads, up-only from the static floors above. The 7/29 ride
// showed on-route bike speeds of 4–7 m/s (occasionally 8–9): at 6.5 m/s the
// static 120 m prepare was only ~18 s of warning and the 30 m act cue ~4.5 s —
// too late to brake and turn. Scaling by the rider's own speed restores the
// intended reaction time (25 s ≈ 163 m, 8 s ≈ 52 m at 6.5 m/s); the floors
// keep walkers and slow riders byte-identical, and the caps keep a downhill
// 9–10 m/s from announcing a turn blocks early. No usable speed on the fix
// (null/0, common in the 7/29 track) → floors, i.e. today's behavior.
const PREPARE_LEAD_SECONDS = 25
const ACT_LEAD_SECONDS = 8
export const PREPARE_LEAD_MAX_M = 250
// Exported: also the tolerance the turn-honesty fixture test allows between an
// announced turn and the rider's on-route projection.
export const ACT_LEAD_MAX_M = 60

/**
 * Check if should notify for upcoming turn
 */
export function checkUpcomingTurn(
  progress: TripProgress,
  currentLeg: Leg,
  sentNotifications: string[]
): NotificationEvent | null {
  const isBike = currentLeg.mode === 'BICYCLE'
  if (!isBike && currentLeg.mode !== 'WALK') return null

  // Speed history is kept for every tick on the leg, including the ticks the
  // guards below discard, so a rejoin hold can't be mistaken for standing still.
  const state = turnStateFor(currentLeg)
  const speed = progress.riderSpeedMps
  // A missing speed counts as moving — never withhold guidance over absent data.
  // (The 7/31 track's first 15 fixes carried no speed at all.)
  state.slowTicks =
    speed != null && speed < MIN_ANNOUNCE_SPEED_MPS ? state.slowTicks + 1 : 0

  // A rejoin/jump settle is under way (see selectCueForNavigation): the cue on
  // screen is already correct, but buzzing it now is the 7/29 rejoin burst —
  // the projection's sweep past 822/992/1003 m announced as still ahead.
  if (progress.turnAnnouncementsHeld) return null

  const cue = progress.nextTurnCue
  const distance = progress.distanceToNextTurn
  if (!cue || distance == null) return null

  const floors = isBike ? BIKE_CUE_DISTANCES : WALK_CUE_DISTANCES
  const prepare =
    speed != null && speed > 0
      ? Math.min(
          Math.max(floors.prepare, speed * PREPARE_LEAD_SECONDS),
          PREPARE_LEAD_MAX_M
        )
      : floors.prepare
  const act =
    speed != null && speed > 0
      ? Math.min(Math.max(floors.act, speed * ACT_LEAD_SECONDS), ACT_LEAD_MAX_M)
      : floors.act
  if (distance > prepare) return null

  // Two cues per turn: one with time to react, one at the corner itself.
  const stage = distance <= act ? 'act' : 'prepare'

  // The latch: this turn, this stage, once for the whole life of the leg.
  // Deliberately permanent — a rider who passes a turn and loops back does not
  // get re-buzzed for it; the on-screen turn card still shows it.
  const stageKey = `${cue.index}_${stage}`
  if (state.announced.has(stageKey)) return null

  // Parked: there is nothing to act on yet, so say nothing until they move —
  // which is exactly when the cue becomes useful. The act stage at the corner
  // is exempt while this turn's prepare cue hasn't fired, so a slow walker
  // easing up to the junction still gets their one cue.
  const stationary = state.slowTicks > STATIONARY_HOLD_TICKS
  const firstCueForTurn =
    stage === 'act' && !state.announced.has(`${cue.index}_prepare`)
  if (stationary && !firstCueForTurn) return null

  // Key on the turn's identity and stage — never the distance, which changes
  // every GPS tick and would defeat the dedup window entirely. This window is
  // now only a backstop under the latch above: it covers the rare mid-approach
  // leg-object replacement, where the latch legitimately starts over.
  const id = generateNotificationId(
    'UPCOMING_TURN',
    `${currentLeg.startTime}_${cue.index}_${stage}`
  )
  if (wasRecentlySent(id, sentNotifications, 30000)) return null

  state.announced.add(stageKey)

  // Instruction leads the title: Garmin shows the title prominently and
  // truncates the body, so "Turn left on Bryant Ave S" must not land there.
  const title = cue.instruction
  const then = progress.followingTurnCue
    ? `, then ${asContinuation(progress.followingTurnCue.instruction)}`
    : ''
  const message =
    stage === 'act'
      ? formatCueDistance(distance)
      : `In ${formatCueDistance(distance)}${then}`

  return {
    id,
    message,
    priority: 'medium',
    timestamp: new Date(),
    title,
    // Only significant turns become TURN_ALERT, the type that is pushed to the
    // phone (and so to the rider's watch). Everything else stays UPCOMING_TURN:
    // on-screen and on the always-current card, but silent.
    type:
      cue.significant && stage === 'prepare' ? 'TURN_ALERT' : 'UPCOMING_TURN'
  }
}

// Lead time for the "time to go" alert: warn when the rider has this many
// seconds (or fewer) of slack left before they must leave to catch the bus.
const LEAVE_SOON_THRESHOLD_SECONDS = 120
// Don't keep firing once they're well past the deadline; a single late nudge
// (down to -60s) still lands if a GPS tick skipped over the exact crossing.
const LEAVE_SOON_FLOOR_SECONDS = -60

/**
 * Check whether it's time to leave: the rider is on the access (walk/bike) leg
 * before a transit leg and the slack until they must depart — to still reach the
 * stop before the bus — has dropped to ~2 minutes. `progress.waitTimeAtStop` is
 * exactly that slack (departure time minus remaining access-leg time).
 *
 * Fires once per trip (long dedup window); high priority so it vibrates and is
 * forwarded to the phone as a real push.
 */
export function checkLeaveSoon(
  progress: TripProgress,
  currentLeg: Leg,
  nextLeg: Leg | undefined,
  sentNotifications: string[]
): NotificationEvent | null {
  const onAccessLeg =
    currentLeg.mode === 'WALK' || currentLeg.mode === 'BICYCLE'
  if (!onAccessLeg || !nextLeg || !isTransitMode(nextLeg.mode)) return null
  if (progress.waitTimeAtStop === undefined) return null

  const leaveInSeconds = progress.waitTimeAtStop
  if (
    leaveInSeconds > LEAVE_SOON_THRESHOLD_SECONDS ||
    leaveInSeconds <= LEAVE_SOON_FLOOR_SECONDS
  ) {
    return null
  }

  const routeName =
    nextLeg.routeShortName || nextLeg.routeLongName || 'your bus'
  const stopName = nextLeg.from?.name || currentLeg.to?.name || 'the stop'
  const verb = currentLeg.mode === 'BICYCLE' ? 'bike' : 'walk'
  const busAwayMin = Math.max(
    1,
    Math.round((progress.timeUntilNextDeparture ?? 0) / 60)
  )

  const id = generateNotificationId('LEAVE_SOON', `${routeName}_${stopName}`)
  // Long window so it fires once for this connection, not every GPS tick.
  if (wasRecentlySent(id, sentNotifications, 30 * 60 * 1000)) return null

  const message =
    leaveInSeconds <= 0
      ? `Leave now — ${verb} to ${stopName} to catch ${routeName} (${busAwayMin} min away).`
      : `Time to go: ${verb} to ${stopName} now to catch ${routeName} (${busAwayMin} min away).`

  return {
    id,
    message,
    priority: 'high',
    timestamp: new Date(),
    title: 'Time to go',
    type: 'LEAVE_SOON'
  }
}

// Grace after the boarded-or-not departure time before declaring a miss.
// With a realtime (GPS-fed) board epoch the bus verifiably left, so only GPS
// jitter needs absorbing; schedule-only data must also absorb an unreported
// late-running bus.
const MISSED_BUS_GRACE_REALTIME_MS = 90_000
const MISSED_BUS_GRACE_SCHEDULED_MS = 180_000
// Above this ground speed the rider is moving at vehicle pace — assume they
// boarded even if vehicle matching hasn't confirmed yet.
const MISSED_BUS_MAX_RIDER_SPEED_MPS = 4
// Within this range of the boarding stop, schedule-only data can't distinguish
// "bus hasn't come" from "rider missed it" — stay ambiguous (card, not swap).
const MISSED_BUS_AT_STOP_RADIUS_M = 50

/** Everything classifyMissedBus needs to judge the upcoming boarding. */
export interface MissedBusInput {
  /** The live record of the vehicle serving the board leg's PLANNED trip —
   * the bus's own geometry, never the rider's stop proximity. */
  boardVehicle?: {
    ageSec: number | null
    distanceToBoardStopM: number | null
    nextStopId: string | null
  } | null
  currentLegIndex: number
  departureOverrideMs: number | null
  legs: Leg[]
  liveLegTimes: Record<number, { boardEpoch: number | null; realtime: boolean }>
  nowMs: number
  riderPosition: [number, number] | null
  riderSpeedMps: number | null
  riding: { legIndex: number } | null
  vehicleConfidence?: string
}

export interface MissedBusContext {
  boardLegIndex: number
  // True when the miss is certain (realtime says the bus left, or the rider is
  // provably away from the stop) — safe to swap the trip without prompting.
  definitive: boolean
  effectiveBoardMs: number
  realtime: boolean
}

/**
 * The departure time the rider actually needs to make: a live (GPS-fed) board
 * epoch beats a rider-selected later departure, which beats the plan's
 * scheduled time. A realtime epoch still in the future means the bus is late,
 * not missed.
 */
export function getEffectiveBoardTimeMs(
  leg: Leg,
  liveLegTime: { boardEpoch: number | null; realtime: boolean } | undefined,
  departureOverrideMs: number | null
): { ms: number; realtime: boolean } {
  if (liveLegTime?.realtime && liveLegTime.boardEpoch != null) {
    return { ms: liveLegTime.boardEpoch, realtime: true }
  }
  if (departureOverrideMs != null) {
    return { ms: departureOverrideMs, realtime: false }
  }
  return { ms: Number(leg.startTime), realtime: false }
}

/**
 * The boarding at stake: index of the first transit leg not yet behind the
 * rider, or -1 when no transit remains. Exported so the classifyMissedBus
 * call site can locate the board leg to build `boardVehicle` from — the same
 * loop must answer in both places or they judge different boardings.
 */
export function findBoardLegIndex(
  legs: Leg[],
  currentLegIndex: number
): number {
  for (let i = currentLegIndex; i < legs.length; i++) {
    if (isTransitMode(legs[i].mode)) return i
  }
  return -1
}

/**
 * Detect a missed boarding: the next transit departure has passed (plus grace)
 * and the rider is verifiably not aboard. Returns null while there is nothing
 * to miss — rider aboard, departure still ahead, or no upcoming transit leg.
 *
 * `definitive` drives what happens next: a definitive miss auto-updates the
 * trip (the app should never ask the rider to confirm what it already knows);
 * an ambiguous one (schedule-only data while standing at the stop — the bus
 * may simply be late) surfaces the regular Switch/Keep card instead.
 */
export function classifyMissedBus(
  input: MissedBusInput
): MissedBusContext | null {
  const {
    boardVehicle,
    currentLegIndex,
    departureOverrideMs,
    legs,
    liveLegTimes,
    nowMs,
    riderPosition,
    riderSpeedMps,
    riding,
    vehicleConfidence
  } = input

  const boardLegIndex = findBoardLegIndex(legs, currentLegIndex)
  if (boardLegIndex === -1) return null
  const boardLeg = legs[boardLegIndex]

  // Aboard already? The sticky riding fact means the rider is on a bus they
  // chose — including the un-anchored legIndex:-1 form an itinerary swap
  // leaves behind — and a missed-bus classification is never valid until
  // clearRiding (90s sustained off-route) has dropped it. A strong vehicle
  // match settles it too, and ground speed at vehicle pace counts: the
  // realtime feed can mark the bus departed the instant the rider boards,
  // before matching confirms.
  //
  // Left unconditional deliberately. The 2026-08-27 false boarding suppressed
  // missed-bus for a whole ten-minute wait, which looks like this guard's
  // fault — but the riding fact there was stamped with legIndex 2, the very
  // leg being boarded, so every "does riding vouch for THIS boarding" test
  // passes it just as readily. The defect was upstream, in establishing the
  // fact at all (see util/go-mode/riding.ts), and that is where it is fixed.
  // Narrowing this guard would not have helped that ride and would undo the
  // 7/29 behaviour that a held riding fact suppresses downstream boardings.
  if (riding) return null
  if (
    currentLegIndex === boardLegIndex &&
    (vehicleConfidence === 'confirmed' || vehicleConfidence === 'high')
  ) {
    return null
  }
  if (riderSpeedMps != null && riderSpeedMps > MISSED_BUS_MAX_RIDER_SPEED_MPS) {
    return null
  }

  // The planned trip's own vehicle outranks a "departed" board epoch: a fresh
  // record showing the bus still headed to / near the boarding stop means the
  // epoch is stale, not the bus gone. On 7/29 MISSED_BUS fired while bus 8140
  // was pulling in 111m from the stop — this measures the BUS against the
  // stop, never the rider.
  if (
    boardVehicle &&
    boardVehicle.ageSec != null &&
    boardVehicle.ageSec <= VEHICLE_RECORD_STALE_SEC
  ) {
    const boardStopId = (boardLeg.from as any)?.stop?.gtfsId ?? null
    const atBoardStop =
      (boardStopId != null && boardVehicle.nextStopId === boardStopId) ||
      (boardVehicle.distanceToBoardStopM != null &&
        boardVehicle.distanceToBoardStopM <= VEHICLE_AT_BOARD_STOP_M)
    if (atBoardStop) return null
  }

  const effective = getEffectiveBoardTimeMs(
    boardLeg,
    liveLegTimes[boardLegIndex],
    // The rider-selected later departure only applies to the upcoming boarding.
    boardLegIndex === currentLegIndex || boardLegIndex === currentLegIndex + 1
      ? departureOverrideMs
      : null
  )
  if (!Number.isFinite(effective.ms)) return null

  const graceMs = effective.realtime
    ? MISSED_BUS_GRACE_REALTIME_MS
    : MISSED_BUS_GRACE_SCHEDULED_MS
  if (nowMs < effective.ms + graceMs) return null

  // Definitive when realtime says the bus left; schedule-only data is only
  // conclusive if the rider is clearly not at the stop (otherwise the bus may
  // just be running late with no realtime reporting).
  let definitive = effective.realtime
  if (!definitive && riderPosition && boardLeg.from) {
    const distanceToStop = calculateDistance(
      riderPosition[0],
      riderPosition[1],
      boardLeg.from.lat,
      boardLeg.from.lon
    )
    definitive = distanceToStop > MISSED_BUS_AT_STOP_RADIUS_M
  }

  return {
    boardLegIndex,
    definitive,
    effectiveBoardMs: effective.ms,
    realtime: effective.realtime
  }
}

/**
 * Build the missed-bus notification (once per missed departure — the id is
 * keyed to the departure epoch, so a later miss of the *next* bus re-fires).
 */
export function checkMissedBus(
  ctx: MissedBusContext,
  legs: Leg[],
  sentNotifications: string[]
): NotificationEvent | null {
  const boardLeg = legs[ctx.boardLegIndex]
  const routeName =
    boardLeg.routeShortName || boardLeg.routeLongName || 'your bus'
  const stopName = boardLeg.from?.name || 'the stop'

  const id = generateNotificationId(
    'MISSED_BUS',
    `${routeName}_${stopName}_${ctx.effectiveBoardMs}`
  )
  if (wasRecentlySent(id, sentNotifications, 30 * 60 * 1000)) return null

  const message = ctx.definitive
    ? `Missed the ${routeName} — updating your trip to the next departure.`
    : `The ${routeName} may have left ${stopName} — checking alternatives…`

  return {
    id,
    message,
    priority: 'high',
    timestamp: new Date(),
    title: 'Missed bus',
    type: 'MISSED_BUS'
  }
}

/**
 * Check if should notify for leg transition
 */
export function checkLegTransition(
  currentLegIndex: number,
  previousLegIndex: number,
  /**
   * The leg the rider is ENTERING — legs[currentLegIndex].
   *
   * This used to be handed legs[currentLegIndex + 1], the leg after, so every
   * transition announced the wrong step. On 2026-08-27 entering the bike leg
   * said "Board 94", entering the 94 said "Board METRO Gold Line", and
   * entering the Gold Line said "Continue to 4Front" — three transitions,
   * three wrong buses named, each one the step the rider had not reached yet.
   */
  enteredLeg: Leg | undefined,
  sentNotifications: string[]
): NotificationEvent | null {
  if (currentLegIndex > previousLegIndex && enteredLeg) {
    // Mode comes from the SAME leg as the index. Pairing one leg's index with
    // another leg's mode also let two different transitions collide inside the
    // 30s dedup window.
    const id = generateNotificationId(
      'LEG_TRANSITION',
      `leg_${currentLegIndex}_${enteredLeg.mode}`
    )

    if (!wasRecentlySent(id, sentNotifications, 30000)) {
      let message = ''

      if (enteredLeg.mode === 'BUS' || enteredLeg.mode === 'RAIL') {
        message = `Board ${
          enteredLeg.routeShortName || enteredLeg.routeLongName
        } to ${enteredLeg.to.name}`
      } else if (enteredLeg.mode === 'WALK') {
        message = `Walk to ${enteredLeg.to.name}`
      } else {
        message = `Continue to ${enteredLeg.to.name}`
      }

      return {
        id,
        message,
        priority: 'high',
        timestamp: new Date(),
        title: 'Next Step',
        type: 'LEG_TRANSITION'
      }
    }
  }

  return null
}

/**
 * How far off the planned route counts as off it, for this leg's mode.
 *
 * Exported so the quiet access-leg re-plan (deviation.ts) can judge a SUSTAINED
 * drift against the same number the alert uses. Two answers to the same
 * question, a few metres apart, is the failure this file already calls the one
 * forbidden disagreement.
 */
export function deviationThresholdM(currentLeg?: Leg): number {
  // 200 m is a walking allowance. On a bike a wrong turn puts that much
  // sideways distance between you and the route in well under a minute, and
  // every extra second spent off-route is another block to backtrack — so react
  // sooner. Still generous enough to absorb GPS scatter and a parallel bike
  // path running alongside the planned street.
  //
  // On a transit leg the threshold is the matcher's own corridor: on
  // 2026-08-27 the matcher said on-route at 248m while this check pushed
  // "you are 239m from the planned route" — two answers to the same question,
  // 9m apart. Pushing "off route" while the matcher holds isOnRoute is the one
  // forbidden disagreement; walk/bike merely being more patient than the 100m
  // corridor is fine.
  return currentLeg?.mode === 'BICYCLE'
    ? 120
    : isTransitMode(currentLeg?.mode)
    ? MATCH_CORRIDOR_TRANSIT_M
    : 200
}

/**
 * How long one deviation stays already-told.
 *
 * Unchanged at 120 s. The window was never too short — it was being destroyed.
 * See DeviationAlertGate.handledAtMs.
 */
export const DEVIATION_ALERT_COOLDOWN_MS = 120000

/**
 * How long after the geometry moves under the rider this alert stays quiet.
 *
 * The same allowance the quiet re-plan gives itself before it will consider
 * another one (QUIET_REPLAN_MIN_COOLDOWN_MS in deviation.ts — not imported,
 * because deviation.ts imports THIS module): the time it takes a rider to
 * converge onto a line they were just handed. Duplicated as a number rather
 * than inverting the dependency, so the two are cross-referenced by comment.
 */
export const DEVIATION_GEOMETRY_SETTLE_MS = 25000

/**
 * The state checkRouteDeviation cannot see for itself.
 *
 * Every field here answers a failure from the 2026-08-27 and 08-28 rides where
 * the 120 s dedup above was live and did nothing, because the evidence it dedups
 * on — `sentNotifications` — is not the rider's memory. START_GO_MODE
 * (reducers/go-mode.ts) deliberately keeps only the stop-keyed ids across an
 * itinerary swap, so every swap wipes `ROUTE_DEVIATION_deviation_*`. The quiet
 * access-leg re-plan swaps the itinerary; the deviation is what triggers it. So
 * the alert was destroying its own suppression through the re-plan it asked for:
 * 8/28 evening, 17:12:57 -> START_GO_MODE 17:12:58.9 -> next card 17:14:45
 * (108 s), and 17:36:33 -> START_GO_MODE 17:36:34.9 -> next card 17:37:28
 * (55 s). Both inside a window that was open the whole time.
 *
 * Supply nothing and the function behaves exactly as it did before the gate
 * existed.
 */
export interface DeviationAlertGate {
  /**
   * When the leg geometry last changed under the rider — an itinerary swap or a
   * leg transition, the two places that already null out the deviation smoother
   * (actions/go-mode.ts). Geometry moving is not a rider going off course:
   * 2026-08-27 pushed at 13:14:04, 0.9 s after the boarded-earlier swap's
   * START_GO_MODE, and at 13:16:20 ("5464m from the planned route"), 1.25 s
   * after TRANSITION_LEG.
   */
  geometryChangedAtMs?: number | null
  /**
   * When this deviation was last DEALT WITH — told to the rider, or silently
   * re-planned around. One clock for both arms, because from the rider's side
   * they are the same event handled two ways; keeping separate ones let a tick
   * that suppressed the card hand the very next tick a clean slate.
   */
  handledAtMs?: number | null
  /** This tick's clock. Without it the timing gates below are all skipped. */
  nowMs?: number | null
  /**
   * A quiet access-leg re-plan will run on THIS tick.
   *
   * Not "did one just run": on 8/28 the push beat its own re-plan by under two
   * seconds three times over (17:12:57, 17:14:45, 17:36:33), so the answer has
   * to be about what is going to happen. The rider does not need to be told
   * about a problem the app is about to fix without them.
   */
  replanImminent?: boolean
}

/** Is `stampMs` inside `windowMs` of `nowMs`? Unknown stamps never suppress. */
function withinWindow(
  nowMs: number,
  stampMs: number | null | undefined,
  windowMs: number
): boolean {
  if (stampMs == null || !Number.isFinite(stampMs)) return false
  const elapsed = nowMs - stampMs
  return elapsed >= 0 && elapsed < windowMs
}

/**
 * Check if should notify for route deviation
 */
export function checkRouteDeviation(
  distanceFromRoute: number,
  sentNotifications: string[],
  currentLeg?: Leg,
  gate?: DeviationAlertGate
): NotificationEvent | null {
  if (distanceFromRoute <= deviationThresholdM(currentLeg)) return null

  if (gate?.replanImminent) return null

  const nowMs = gate?.nowMs
  if (nowMs != null && Number.isFinite(nowMs)) {
    if (withinWindow(nowMs, gate?.handledAtMs, DEVIATION_ALERT_COOLDOWN_MS)) {
      return null
    }
    if (
      withinWindow(
        nowMs,
        gate?.geometryChangedAtMs,
        DEVIATION_GEOMETRY_SETTLE_MS
      )
    ) {
      return null
    }
  }

  // Stable context: the measured distance changes every GPS tick, so it must
  // not be part of the dedup key or the 120s window never matches. Kept as the
  // in-trip backstop for the gate above; it is the one that cannot survive an
  // itinerary swap, which is why it is no longer the only floor.
  const id = generateNotificationId('ROUTE_DEVIATION', 'deviation')
  if (wasRecentlySent(id, sentNotifications, DEVIATION_ALERT_COOLDOWN_MS)) {
    return null
  }

  return {
    id,
    message: `You are ${Math.round(distanceFromRoute)}m from the planned route`,
    priority: 'high',
    timestamp: new Date(),
    title: 'Off Route',
    type: 'ROUTE_DEVIATION'
  }
}

/**
 * Tell the rider that re-planning has stopped helping.
 *
 * Raised once the across-replans tracker (destination-progress.ts) retires an
 * access mode as non-convergent — three re-plans with no net reduction in
 * distance to the destination. On 2026-08-28 the afternoon ride re-planned into
 * the State Fairgrounds interior for 32 minutes and never got inside 454 m; the
 * app kept promising an arrival the street graph could not deliver, and said
 * nothing when the promise stopped being true.
 *
 * Deliberately a plain notification and nothing more: it uses the same event
 * shape, the same dedup and the same push path as every other alert, so there
 * is no new surface to maintain for a case that should be rare. The dedup
 * window is a whole hour on a stable id — this is a fact about the trip, not a
 * status, and repeating it helps nobody.
 */
export function checkDestinationUnreachable(
  sentNotifications: string[],
  distanceM: number | null | undefined,
  destinationName?: string | null
): NotificationEvent | null {
  const id = generateNotificationId('DESTINATION_UNREACHABLE', 'destination')
  if (wasRecentlySent(id, sentNotifications, 3600000)) return null
  const where = destinationName ? ` from ${destinationName}` : ''
  const howFar =
    distanceM != null && Number.isFinite(distanceM)
      ? `${Math.round(distanceM)}m`
      : 'some way'
  return {
    id,
    message:
      `Still ${howFar}${where} and re-planning isn't closing the gap — ` +
      'the last stretch may not be on the map. Finish from here your own way.',
    priority: 'high',
    timestamp: new Date(),
    title: 'This is as close as routing gets',
    type: 'DESTINATION_UNREACHABLE'
  }
}

const TRANSIT_MODES = ['BUS', 'RAIL', 'SUBWAY', 'TRAM', 'FERRY']

function isTransitMode(mode: string | undefined): boolean {
  return mode != null && TRANSIT_MODES.includes(mode)
}

// Minimum lateness before a connection warning is worth raising (seconds).
const CONNECTION_MIN_DELAY_SECONDS = 60
// Warn once the projected slack to the connecting departure drops below this.
const CONNECTION_SLACK_THRESHOLD_SECONDS = 120

/**
 * Find the next transit leg after the given index, summing any walk/transfer
 * time on the legs in between. Returns null when no onward transit leg exists.
 */
function findNextTransitConnection(
  legs: Leg[],
  fromIndex: number
): { leg: Leg; transferSeconds: number } | null {
  let transferSeconds = 0
  for (let i = fromIndex + 1; i < legs.length; i++) {
    if (isTransitMode(legs[i].mode)) {
      return { leg: legs[i], transferSeconds }
    }
    transferSeconds += legs[i].duration || 0
  }
  return null
}

/**
 * Build the user-facing copy for a connection warning.
 */
function connectionWarningCopy(
  routeName: string,
  stopName: string,
  delaySeconds: number,
  slackSeconds: number
): { message: string; title: string } {
  const atStop = stopName ? ` at ${stopName}` : ''
  if (slackSeconds < 0) {
    const lateMin = Math.max(1, Math.round(delaySeconds / 60))
    return {
      message: `Running ${lateMin} min late — you may miss ${routeName}${atStop}.`,
      title: 'Connection at risk'
    }
  }
  return {
    message: `Tight connection — about ${Math.round(
      slackSeconds
    )}s to catch ${routeName}${atStop}.`,
    title: 'Tight connection'
  }
}

/**
 * Check whether a downstream transfer is at risk because the current transit
 * leg is running late.
 *
 * Real-data only: `progress.delay` is the rider's measured GPS-vs-schedule lag
 * on the current leg. We project that lag forward to the transfer stop and
 * compare against the *planned* connecting departure (the connecting service's
 * own real-time delay is not yet accounted for — the warning is therefore
 * conservative and may over-warn if the connection is also late).
 */
/** How much the margin must deteriorate before the rider is told again. */
const CONNECTION_REWARN_WORSEN_SECONDS = 30

interface ConnectionWarnState {
  warnedSlackSeconds: number
}
let connectionWarnState = new WeakMap<Leg, ConnectionWarnState>()

/**
 * Drop every connection's warned-margin baseline. Test-only, exactly like
 * resetTurnAnnouncements: in production the lifetime is the leg object.
 */
export function resetConnectionWarnings(): void {
  connectionWarnState = new WeakMap<Leg, ConnectionWarnState>()
}

export function checkConnectionWarning(
  progress: TripProgress,
  legs: Leg[],
  currentLegIndex: number,
  sentNotifications: string[]
): NotificationEvent | null {
  const currentLeg = legs[currentLegIndex]
  if (!currentLeg || !isTransitMode(currentLeg.mode)) return null

  // Only meaningful when the current leg is actually behind schedule.
  const delaySeconds = progress.delay ?? 0
  if (delaySeconds < CONNECTION_MIN_DELAY_SECONDS) return null

  const connection = findNextTransitConnection(legs, currentLegIndex)
  if (!connection) return null // no onward transit connection to miss
  const { leg: nextTransitLeg, transferSeconds } = connection

  // Project arrival at the transfer stop assuming the delay persists, then see
  // whether the rider can still reach the connecting departure in time.
  // Leg start/end times are typed number | string in @opentripplanner/types.
  const projectedArrivalMs = Number(currentLeg.endTime) + delaySeconds * 1000
  const slackSeconds =
    (Number(nextTransitLeg.startTime) - projectedArrivalMs) / 1000 -
    transferSeconds

  if (slackSeconds >= CONNECTION_SLACK_THRESHOLD_SECONDS) return null

  const routeName =
    nextTransitLeg.routeShortName ||
    nextTransitLeg.routeLongName ||
    'your connection'
  const stopName = nextTransitLeg.from?.name || currentLeg.to?.name || ''
  const id = generateNotificationId(
    'CONNECTION_WARNING',
    `${routeName}_${stopName}`
  )

  if (wasRecentlySent(id, sentNotifications, 120000)) return null

  // Only warn again when the margin has actually got WORSE.
  //
  // Slack is recomputed from scratch every tick out of progress.delay, which
  // swings tick to tick, and nothing remembered what had already been said. On
  // 2026-08-27 the rider was warned four times about the same Gold Line
  // connection at Rice Park — "about 56s", then 102s, then 120s, then 19s —
  // three of them while the margin was IMPROVING as they closed on the stop.
  // The 120s dedup window could not help: it is exactly
  // CONNECTION_SLACK_THRESHOLD_SECONDS, so the alert re-armed as fast as the
  // situation could change.
  //
  // State is keyed on the connecting leg object, the same trick
  // resetTurnAnnouncements uses: a new itinerary means new legs, so a swap
  // clears the baseline without anything having to remember to.
  const previouslyWarned = connectionWarnState.get(nextTransitLeg)
  if (
    previouslyWarned &&
    slackSeconds >
      previouslyWarned.warnedSlackSeconds - CONNECTION_REWARN_WORSEN_SECONDS
  ) {
    return null
  }
  connectionWarnState.set(nextTransitLeg, { warnedSlackSeconds: slackSeconds })

  const { message, title } = connectionWarningCopy(
    routeName,
    stopName,
    delaySeconds,
    slackSeconds
  )

  return {
    id,
    message,
    priority: 'high',
    timestamp: new Date(),
    title,
    type: 'CONNECTION_WARNING'
  }
}

// Minimum lateness on the current leg before alerting the rider (seconds).
const DELAY_ALERT_THRESHOLD_SECONDS = 180

/**
 * Check whether the transit leg the rider is currently on is running late
 * enough to warrant a heads-up.
 *
 * Real-data only: uses `progress.delay`, the measured GPS-vs-schedule lag on
 * the current leg. The alert id buckets the delay into 5-minute increments so
 * worsening lateness re-alerts (3 min, then 8 min, ...) without spamming on
 * small fluctuations within a bucket.
 */
export function checkDelayAlert(
  progress: TripProgress,
  currentLeg: Leg,
  sentNotifications: string[],
  /** Legs of the active itinerary, so the alert can tell it is still on one. */
  legs?: Leg[]
): NotificationEvent | null {
  if (!isTransitMode(currentLeg.mode)) return null

  // Is this leg still the one the rider is on?
  //
  // The function's whole world was progress.delay and whatever leg it was
  // handed, so it could not tell a bus the rider is sitting on from one they
  // have already left. matchPositionToRoute only searches forward, so between
  // physically stepping off and the leg transition firing, the finished bus
  // leg keeps accruing delay — and on 2026-08-27 it announced "94 is running
  // about 3 min late" 64 seconds AFTER the rider got off it at Rice Park.
  if (legs && legs[progress.currentLegIndex] !== currentLeg) return null

  // Near the end of a leg the rider is arriving, not riding: a delay they can
  // no longer do anything about is noise.
  if ((progress.currentLegProgress ?? 0) >= 99) return null

  const delaySeconds = progress.delay ?? 0
  if (delaySeconds < DELAY_ALERT_THRESHOLD_SECONDS) return null

  const routeName =
    currentLeg.routeShortName || currentLeg.routeLongName || 'Your ride'
  const lateMin = Math.max(1, Math.round(delaySeconds / 60))
  const bucket = Math.floor(delaySeconds / 300)
  const id = generateNotificationId('DELAY_ALERT', `${routeName}_${bucket}`)

  if (wasRecentlySent(id, sentNotifications, 300000)) return null

  return {
    id,
    message: `${routeName} is running about ${lateMin} min late.`,
    priority: 'medium',
    timestamp: new Date(),
    title: 'Running late',
    type: 'DELAY_ALERT'
  }
}

/**
 * Check if should notify for trip completion
 */
export function checkTripComplete(
  progress: TripProgress,
  sentNotifications: string[]
): NotificationEvent | null {
  // One arrival rule, defined next to the status it produces. This used to
  // repeat `overallProgress >= 99.5` inline, as did the latch in actions/
  // go-mode.ts — three copies that could disagree, and on 2026-08-27 all three
  // missed a real arrival at 99.28%.
  if (
    progress.status === 'completed' ||
    hasArrivedAtDestination(
      progress.overallProgress,
      progress.distanceToDestination
    )
  ) {
    const id = generateNotificationId('TRIP_COMPLETE', 'trip_end')

    if (!wasRecentlySent(id, sentNotifications)) {
      return {
        id,
        message: 'You have arrived at your destination!',
        priority: 'medium',
        timestamp: new Date(),
        title: 'Trip Complete',
        type: 'TRIP_COMPLETE'
      }
    }
  }

  return null
}

/**
 * Append a notification to the list when one was produced.
 */
function pushIf(
  notifications: NotificationEvent[],
  event: NotificationEvent | null
): void {
  if (event) notifications.push(event)
}

/**
 * Process all notification checks and return any that should be triggered
 */
export function checkForNotifications(
  progress: TripProgress,
  currentLeg: Leg,
  previousLegIndex: number,
  nextLeg: Leg | undefined,
  distanceFromRoute: number,
  sentNotifications: string[],
  config: NotificationConfig,
  legs?: Leg[],
  alight?: AlightContext,
  deviation?: DeviationAlertGate
): NotificationEvent[] {
  if (!config.enabled) {
    return []
  }

  const notifications: NotificationEvent[] = []

  // Highest-priority, always-checked alerts.
  if (alight) {
    pushIf(
      notifications,
      checkAlightAlerts(progress, currentLeg, alight, sentNotifications)
    )
  }
  pushIf(
    notifications,
    checkLeaveSoon(progress, currentLeg, nextLeg, sentNotifications)
  )
  pushIf(
    notifications,
    checkLegTransition(
      progress.currentLegIndex,
      previousLegIndex,
      // currentLeg, NOT nextLeg: announce the step being entered. `nextLeg` is
      // still right for checkLeaveSoon and the pacing card, which are about
      // what comes after.
      currentLeg,
      sentNotifications
    )
  )
  pushIf(
    notifications,
    checkRouteDeviation(
      distanceFromRoute,
      sentNotifications,
      currentLeg,
      deviation
    )
  )

  // At-risk downstream connection (needs the full leg list).
  const connectionWarning = legs
    ? checkConnectionWarning(
        progress,
        legs,
        progress.currentLegIndex,
        sentNotifications
      )
    : null
  pushIf(notifications, connectionWarning)

  // Running-late heads-up. Skipped when a connection warning already fired,
  // since that message conveys the lateness.
  if (!connectionWarning) {
    pushIf(
      notifications,
      checkDelayAlert(progress, currentLeg, sentNotifications, legs)
    )
  }

  pushIf(notifications, checkTripComplete(progress, sentNotifications))

  // Turn cues are real navigation now, not the "Continue to X" filler they used
  // to be, so they are no longer suppressed by any alert that happens to fire in
  // the same tick. Only the two that would have the rider abandoning this leg
  // outright still win — following a turn onto a bus you've already missed is
  // worse than saying nothing.
  const supersedesTurn = notifications.some(
    (n) => n.type === 'MISSED_BUS' || n.type === 'CONNECTION_WARNING'
  )
  if (!supersedesTurn) {
    pushIf(
      notifications,
      checkUpcomingTurn(progress, currentLeg, sentNotifications)
    )
  }

  return notifications
}

/**
 * Show notification to user (in-app toast/modal)
 */
export function showNotification(
  event: NotificationEvent,
  config: NotificationConfig
): void {
  // Trigger vibration for high priority notifications
  if (event.priority === 'high' && config.vibrationEnabled) {
    triggerVibration([200, 100, 200], config)
  }

  // Dispatch custom event that UI components can listen to
  const customEvent = new CustomEvent('go-mode-notification', {
    detail: event
  })
  window.dispatchEvent(customEvent)
}
