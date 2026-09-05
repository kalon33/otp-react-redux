import type { Itinerary, Leg } from '@opentripplanner/types'
import { asContinuation, formatCueDistance, formatCueDistanceImperial } from './turn-by-turn'
import {
  calculateDistance,
  MATCH_CORRIDOR_TRANSIT_M
} from './position-matching'
import { hasArrivedAtDestination } from './progress-calculator'
import { MISSED_BUS_NOTICE_ID } from './native-notify'
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
  /**
   * Stable NATIVE notification id, when this alert needs to be replaceable or
   * withdrawable on the phone (see PushPayload.id in native-notify.ts). Omitted
   * by almost everything: a one-off alert wants its own entry in Notification
   * Center. Set by the ambiguous missed-bus outcome, which is a claim about the
   * world that can stop being true while the rider is looking at it.
   */
  pushId?: number
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
 * Its one caller is the quiet access-leg re-plan — never an automatic swap of
 * the transit half. (This used to say "surfaced as a Switch/Keep card"; that
 * card was deleted in eb74a9d8 and nothing has rendered one since.)
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

/**
 * How far a rider-selected departure may sit from the itinerary's own board
 * time and still be a statement about the SAME run.
 *
 * Two different things dispatch SET_DEPARTURE_OVERRIDE: the rider picking a
 * later bus from the card (selectDeparture), and the auto-anchor re-targeting
 * the soonest catchable departure of the same route (departure-anchor.ts).
 * The second frequently writes the planned run's own live time, shifted by a
 * few minutes of lateness — the same bus, re-timed. The first names a
 * different vehicle entirely. Ten minutes separates them: a bus can plausibly
 * run that late, and the route the rider was on runs every ~30 min, so the
 * next run is never inside the window. Measured on 2026-09-04: planned board
 * 11:15:30, override 12:13:00 — 57.5 min out, a different run beyond argument.
 */
export const SAME_RUN_TOLERANCE_MS = 10 * 60 * 1000

/**
 * Slack allowed before a boarding counts as one the rider cannot make.
 *
 * Generous on purpose: the alert exists to make a rider hurry, so a boarding
 * they are two minutes short of is still worth shouting about — the bus may
 * be late, or they may sprint. What it stops is the 2026-09-04 case, where
 * 4.4 km of unstarted bike leg (~18 min at the planned pace) was announced as
 * an arriving bus.
 */
export const BOARD_REACH_MARGIN_SECONDS = 120

/**
 * Whether a rider-selected departure names a run OTHER than the one this leg
 * boards.
 *
 * Symmetric: an override EARLIER than the plan (the auto-anchor catching a
 * bus the rider can still make) describes a different vehicle just as much as
 * a later one does, and the planned trip's feed record says nothing about
 * either. Unknowable inputs answer false — never silence on a missing number.
 */
export function overrideNamesAnotherRun(
  plannedBoardMs: number | null | undefined,
  departureOverrideMs: number | null | undefined
): boolean {
  if (departureOverrideMs == null || !Number.isFinite(departureOverrideMs)) {
    return false
  }
  if (plannedBoardMs == null || !Number.isFinite(plannedBoardMs)) return false
  return Math.abs(departureOverrideMs - plannedBoardMs) > SAME_RUN_TOLERANCE_MS
}

/** What the board-vehicle alerts need, measured in the action layer. */
export interface BoardVehicleContext {
  /**
   * goMode.departureOverride — the departure the rider (or the auto-anchor)
   * is actually targeting. Optional: absent means "no pick", and the gate
   * that reads it stays open, so callers that never had one are unchanged.
   */
  departureOverrideMs?: number | null
  /** The live (realtime-flagged) board prediction for the boarding leg. */
  liveBoardEpochMs: number | null
  nowMs: number
  /**
   * Seconds of ground still in front of the rider before the boarding stop,
   * at the pace they are actually keeping — accessSecondsToBoardStop in
   * progress-calculator.ts, which is the same remaining-leg arithmetic the
   * pacing card and the quiet re-plan already run. Optional; null/absent
   * means unmeasurable, and the reachability gate stays open.
   */
  secondsToBoardStop?: number | null
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
 *
 * Two further gates, from the 2026-09-04 kerb ride, where both stages fired
 * for a run the rider had stood down from while they were still 4.4 km away
 * with the bike leg unstarted ("Pointless notification about a bus stop I'm
 * not at yet and a bus before the one on the plan", 11:13:15):
 *
 *  - the run must still be THEIRS. A rider-selected departure that names a
 *    different run makes the planned trip's vehicle somebody else's bus, and
 *    its feed record is not news.
 *  - the boarding must be one they could plausibly make. The check is against
 *    the ground still ahead of them at their own pace, not their distance as
 *    the crow flies — a rider 300 m from the stop by road is closer than one
 *    100 m away across a freeway.
 */
export function checkBoardVehicleApproach(
  boardLeg: Leg,
  ctx: BoardVehicleContext,
  sentNotifications: string[]
): NotificationEvent | null {
  const {
    departureOverrideMs,
    liveBoardEpochMs,
    nowMs,
    secondsToBoardStop,
    vehicle
  } = ctx
  if (!vehicle) return null
  if (vehicle.ageSec != null && vehicle.ageSec > VEHICLE_RECORD_STALE_SEC) {
    return null
  }

  // Gate A — the rider stood down from this run. The board leg still carries
  // the planned trip, so `vehicle` is a real, fresh record of a real bus; it
  // is simply not the bus they are going to get on.
  if (
    overrideNamesAnotherRun(Number(boardLeg.startTime), departureOverrideMs)
  ) {
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

  // Gate B — can the rider actually be there? How long the bus is still going
  // to be reachable for: at the stop it is leaving now; otherwise the feed's
  // own prediction, or, with no prediction behind the distance trigger, the
  // window that let this alert fire at all.
  const secondsUntilVehicle = atStop
    ? 0
    : liveBoardEpochMs != null
    ? Math.max(0, (liveBoardEpochMs - nowMs) / 1000)
    : BOARD_APPROACH_SECONDS
  if (
    secondsToBoardStop != null &&
    Number.isFinite(secondsToBoardStop) &&
    secondsToBoardStop > secondsUntilVehicle + BOARD_REACH_MARGIN_SECONDS
  ) {
    return null
  }

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
 * How far apart the two cards for one turn have to land, in seconds of riding,
 * before the second one is worth sending.
 *
 * The prepare card already names the turn and the distance; the sticky turn
 * card (turn-card.ts) then holds that instruction on the rider's wrist and the
 * screen counts the metres down. So the act card at the corner is new
 * information only when the prepare card was long enough ago to have been
 * forgotten.
 *
 * 2026-09-01 ride 1, the 7 min 8 s bike leg that produced this rule: prepare
 * and act landed 12 s apart (08:56:15 / 08:56:27), 16 s (08:56:23 / 08:56:39),
 * 20 s (08:58:03 / 08:58:23), 16 s (08:58:31 / 08:58:47) and 28 s (08:59:07 /
 * 08:59:35) — five second cards inside half a minute of their own first card.
 * The one pair that was genuinely far apart was the rider dawdling off the bus:
 * 08:52:34 to 08:54:16, 102 s. 45 s keeps that one and drops the other five.
 *
 * Judged from the leads in force this tick rather than from a remembered
 * announcement time, so it needs no extra state and it moves with the rider's
 * own speed: the same gap that is 17 s at 5.5 m/s is 112 s for someone walking
 * a bike at 0.8 m/s, and the slow rider keeps both cards.
 */
export const ACT_REMINDER_MIN_GAP_SECONDS = 45

/**
 * Check if should notify for upcoming turn
 */
export function checkUpcomingTurn(
  progress: TripProgress,
  currentLeg: Leg,
  sentNotifications: string[],
  turnCuesEnabled = true
): NotificationEvent | null {
  // The rider's own switch (util/go-mode/turn-cue-settings): the global default
  // is OFF, and a leg they opted in from the trip sheet turns it back on. This
  // is the FIRST gate on purpose — before the per-leg latch below is written —
  // so a silenced approach doesn't burn the one cue the rider would get if they
  // flipped the switch mid-leg. Defaults to true so a caller that knows nothing
  // about the setting (the unit suites for the turn logic itself) still
  // exercises the producer.
  if (!turnCuesEnabled) return null

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

  // …but only where those two moments are far enough apart to be two different
  // pieces of news. See ACT_REMINDER_MIN_GAP_SECONDS. A rider who was never
  // told about this turn still gets the corner cue — that case is handled by
  // `firstCueForTurn` below, and this gate defers to it.
  const twoStageWorthIt =
    speed == null ||
    !(speed > 0) ||
    (prepare - act) / speed >= ACT_REMINDER_MIN_GAP_SECONDS
  if (
    stage === 'act' &&
    !twoStageWorthIt &&
    state.announced.has(`${cue.index}_prepare`)
  ) {
    return null
  }

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
      ? formatCueDistanceImperial(distance)
      : `In ${formatCueDistanceImperial(distance)}${then}`

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
// "bus hasn't come" from "rider missed it" — stay ambiguous, which means plan
// alternatives and show them, never swap the trip.
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
  liveLegTimes: Record<
    number,
    { boardEpoch: number | null; boardRealtime?: boolean; realtime: boolean }
  >
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
 * epoch beats a rider-selected departure, which beats the plan's scheduled
 * time. A realtime epoch still in the future means the bus is late, not
 * missed.
 *
 * Two corrections from the 2026-09-04 kerb ride:
 *
 * 1. "Realtime" means the BOARD field's own flag. The leg-level `realtime` is
 *    an OR across board and alight (live-itinerary.ts says the same of
 *    legBoard/legAlight), and on that ride the boarding's alight was live
 *    while its board was a schedule time clamped forward to `now` once a
 *    second by clampNonLiveLegTimes. Reading the leg-level flag made that
 *    fabricated "now" the effective departure, so classifyMissedBus could
 *    never conclude the bus had gone: it declared the miss seven minutes late
 *    (11:22:41), off a board time of 11:20:00 that no feed ever published,
 *    when the run boarded at 11:15:30.
 *
 * 2. An override that names a DIFFERENT RUN is not an answer to this
 *    question. This function says when the boarding IN THE ITINERARY happens
 *    — which run the rider intends to take is a different fact, and the two
 *    were being conflated. A late bus on the same run still outranks the
 *    override (rank 1 below, unchanged); a rider-selected later run does not
 *    push the planned boarding into the future, because the planned run
 *    departs when it departs, and pretending otherwise is what suppressed
 *    missed-bus recovery on a trip that was already un-flyable. Whether the
 *    rider has declined a run is answered where it belongs — Gate A of
 *    checkBoardVehicleApproach, which stays silent about that run's vehicle.
 */
export function getEffectiveBoardTimeMs(
  leg: Leg,
  liveLegTime:
    | { boardEpoch: number | null; boardRealtime?: boolean; realtime: boolean }
    | undefined,
  departureOverrideMs: number | null
): { ms: number; realtime: boolean } {
  const boardRealtime = liveLegTime?.boardRealtime ?? liveLegTime?.realtime
  if (boardRealtime && liveLegTime?.boardEpoch != null) {
    return { ms: liveLegTime.boardEpoch, realtime: true }
  }
  const plannedMs = Number(leg.startTime)
  if (
    departureOverrideMs != null &&
    !overrideNamesAnotherRun(plannedMs, departureOverrideMs)
  ) {
    return { ms: departureOverrideMs, realtime: false }
  }
  return { ms: plannedMs, realtime: false }
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
 * may simply be late) must NOT swap the route, so it re-plans without applying
 * and hands the rider the alternatives in the planner — see the ambiguous
 * branch of handlePositionUpdate and {@link buildMissedBusOutcomeNotice}.
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
    const boardStopId =
      ((boardLeg.from as any)?.stop?.gtfsId ||
        (boardLeg.from as any)?.stopId) ??
      null
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

/** The route as the rider would name it. */
function legRouteName(leg: Leg | undefined): string {
  return leg?.routeShortName || leg?.routeLongName || 'your bus'
}

/**
 * Build the missed-bus notification for a DEFINITIVE miss (once per missed
 * departure — the id is keyed to the departure epoch, so a later miss of the
 * *next* bus re-fires).
 *
 * An AMBIGUOUS miss deliberately returns null and says nothing yet. It used to
 * push "…may have left… — checking alternatives…" the instant it was detected,
 * and that was the whole of it: the alternatives landed in `goMode.reRoute`
 * 4.5 s later (2 real itineraries, 2026-09-03 18:24:39 → 18:24:43) and no
 * screen has rendered that slice since eb74a9d8 deleted the Switch/Keep card.
 * The rider was told a search was running and then never told anything again.
 * The honest version is one push carrying the outcome, sent once the candidates
 * are in — {@link buildMissedBusOutcomeNotice}, raised by handlePositionUpdate.
 */
export function checkMissedBus(
  ctx: MissedBusContext,
  legs: Leg[],
  sentNotifications: string[]
): NotificationEvent | null {
  if (!ctx.definitive) return null
  const boardLeg = legs[ctx.boardLegIndex]
  const routeName = legRouteName(boardLeg)

  const id = generateNotificationId(
    'MISSED_BUS',
    `${routeName}_${boardLeg.from?.name || 'the stop'}_${ctx.effectiveBoardMs}`
  )
  if (wasRecentlySent(id, sentNotifications, 30 * 60 * 1000)) return null

  return {
    id,
    message: `Missed the ${routeName} — updating your trip to the next departure.`,
    priority: 'high',
    timestamp: new Date(),
    title: 'Missed bus',
    type: 'MISSED_BUS'
  }
}

/**
 * The one push an AMBIGUOUS missed bus gets, built once its re-plan has
 * settled — so it carries the answer instead of promising one.
 *
 * Copy is the rider's standing rule for notification text: the numbers they
 * act on and nothing else. No clock times (the wait in minutes is what a rider
 * standing at a stop uses), no coaching, no question — an ambiguous miss must
 * never swap their route, so there is nothing to confirm. The route is named
 * only when the best alternative is a DIFFERENT one; when the next departure of
 * their own route is the answer, repeating its name adds nothing.
 *
 * `candidates` is `goMode.reRoute.candidates` — the itineraries the re-plan
 * actually returned, ranked as collectRerouteCandidates left them. Empty means
 * the search settled with nothing, and the rider is told that in the same push
 * rather than left waiting on a search that already finished.
 */
export function buildMissedBusOutcomeNotice(input: {
  candidates: Itinerary[]
  ctx: MissedBusContext
  legs: Leg[]
  nowMs: number
}): NotificationEvent {
  const { candidates, ctx, legs, nowMs } = input
  const missedRouteName = legRouteName(legs[ctx.boardLegIndex])

  const best = candidates[0]
  const bestTransitLeg = (best?.legs || []).find((l: Leg) => l.transitLeg)
  const bestName = bestTransitLeg ? legRouteName(bestTransitLeg) : null
  const boardMs = Number(bestTransitLeg?.startTime ?? best?.startTime)
  const minutes = Number.isFinite(boardMs)
    ? Math.max(0, Math.round((boardMs - nowMs) / 60000))
    : null

  let message: string
  if (!best) {
    message = `${missedRouteName} likely missed · no alternatives`
  } else if (minutes == null) {
    message = `${missedRouteName} likely missed · ${candidates.length} options`
  } else if (bestName && bestName !== missedRouteName) {
    message = `${missedRouteName} likely missed · ${bestName} in ${minutes} min`
  } else {
    message = `${missedRouteName} likely missed · next in ${minutes} min`
  }

  return {
    id: generateNotificationId(
      'MISSED_BUS',
      `outcome_${missedRouteName}_${ctx.effectiveBoardMs}`
    ),
    message,

    priority: 'high',
    // One stable native id, so a second push (nothing → alternatives) REPLACES
    // the first rather than stacking, and so a miss that turns out not to have
    // happened can be taken off the rider's lock screen and their wrist.
    pushId: MISSED_BUS_NOTICE_ID,
    timestamp: new Date(nowMs),
    title: 'Missed bus',
    type: 'MISSED_BUS'
  }
}

/**
 * Legs whose entry has already been announced.
 *
 * The 30 s `wasRecentlySent` window was never a latch, and the condition it was
 * guarding — `currentLegIndex > previousLegIndex` — is not an edge. It is a
 * standing comparison between the matcher's projection and
 * `session.lastTransitionedLegIndex`, and when the board-time gate refuses the
 * transition (actions/go-mode.ts, `shouldTransitionToNextLeg`) the two disagree
 * for as long as the refusal lasts. On 2026-09-01 ride 2 that was five minutes:
 * "Board METRO Orange Line to I-35W & 98th St Station" went out ELEVEN times,
 * 10:37:35 → 10:42:11, one every 30–32 s, each one the moment the window
 * reopened. (The ride report blamed the `Date.now()` suffix on the id; it does
 * not survive `wasRecentlySent`, which strips the last underscore-separated
 * field before comparing. The suffix was innocent and the window was the bug.)
 *
 * So the fact, not the moment: this leg, entered, announced. Keyed on the leg
 * OBJECT exactly like the turn latch above — one itinerary's legs are stable
 * for its lifetime, a swap hands back new objects and re-arms the announcement
 * for what is genuinely a new trip, and the whole map is collectable when the
 * trip ends.
 */
let announcedLegEntries = new WeakSet<Leg>()

/**
 * Forget which legs have been announced. Test-only, for the same reason as
 * resetTurnAnnouncements: production lifetime is the leg object itself, but
 * unit tests reuse one leg literal across cases.
 */
export function resetLegAnnouncements(): void {
  announcedLegEntries = new WeakSet<Leg>()
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

    if (
      !announcedLegEntries.has(enteredLeg) &&
      !wasRecentlySent(id, sentNotifications, 30000)
    ) {
      announcedLegEntries.add(enteredLeg)
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
 * The `deviationHandledAtMs` stamp to carry into the next tick.
 *
 * `checkRouteDeviation`'s 120 s cooldown counts from when a deviation was last
 * DEALT WITH, and that was enough for the 2026-08-28 storms because those were
 * repeats across an itinerary swap. It is not enough for a rider who is simply
 * still off the line: on 2026-09-01 ride 2 the cooldown re-armed on schedule and
 * "Off Route" went out at 10:37:15, 10:39:15, 10:41:15, 10:43:15 and 10:45:19 —
 * five cards, 120 s apart to the second, for one continuous 663 -> 842 -> 750 m
 * excursion. Nothing changed between them that the rider could act on.
 *
 * So the clock is held while the excursion lasts. The cooldown then measures
 * time since the rider came BACK, which makes it what the row asked for: one
 * card per deviation EPISODE, with 120 s of floor before the next episode can
 * speak.
 *
 * The stamp is only ever EXTENDED, never opened: a tick that is off route while
 * the window is already shut keeps it shut, but a deviation that has not yet
 * been reported — held by the geometry-settle window, say — is left alone, so
 * the first card of an episode still lands when the settle expires.
 */
export function nextDeviationHandledAtMs(input: {
  /** A ROUTE_DEVIATION card went out on this tick. */
  alerted: boolean
  /** The leg the rider is on, for the per-mode threshold. */
  currentLeg?: Leg
  /** This tick's smoothed distance from the planned route. */
  distanceFromRoute?: number | null
  /** The stamp carried in from the previous tick. */
  handledAtMs: number | null
  nowMs: number
  /** A quiet access-leg re-plan will run on this tick. */
  replanImminent: boolean
}): number | null {
  const {
    alerted,
    currentLeg,
    distanceFromRoute,
    handledAtMs,
    nowMs,
    replanImminent
  } = input

  // Told, or silently re-planned around: both are the deviation being handled.
  if (alerted || replanImminent) return nowMs

  const stillOffRoute =
    distanceFromRoute != null &&
    Number.isFinite(distanceFromRoute) &&
    distanceFromRoute > deviationThresholdM(currentLeg)

  if (
    stillOffRoute &&
    withinWindow(nowMs, handledAtMs, DEVIATION_ALERT_COOLDOWN_MS)
  ) {
    return nowMs
  }

  return handledAtMs
}

/**
 * The epoch the rider should be told they will ARRIVE, for an itinerary that
 * has just replaced the one they were on.
 *
 * The aboard re-plan's "Trip updated" copy read the arrival off `legs[0]` —
 * the bus the rider is sitting on — so it named the moment they get OFF the bus
 * and called it the arrival. 2026-09-01 ride 1, 08:26:27: *"…to I-35W & Lake St
 * Station, arriving 8:45 AM"*, while the itinerary it had just installed ended
 * at 08:51:45 and the trip sheet on the same screen said so. Two answers to one
 * question, 6m41s apart, on the same tick.
 *
 * Falls back to the last leg's end when the itinerary carries no `endTime`, and
 * returns null rather than inventing one.
 */
export function itineraryArrivalMs(itinerary: any): number | null {
  const end = Number(itinerary?.endTime)
  if (Number.isFinite(end) && end > 0) return end
  const legs = itinerary?.legs
  const lastEnd = Number(legs?.[legs.length - 1]?.endTime)
  return Number.isFinite(lastEnd) && lastEnd > 0 ? lastEnd : null
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
 * How much worse the stated lateness has to get before the rider hears it
 * again, in whole minutes — the same shape as CONNECTION_REWARN_WORSEN_SECONDS
 * and for the same reason.
 */
const DELAY_REWARN_WORSEN_MINUTES = 2

interface DelayWarnState {
  /** The number of minutes the rider was last actually told. */
  warnedLateMin: number
}

/**
 * What the rider has already been told about each leg's lateness. Keyed on the
 * leg object, like connectionWarnState: an itinerary swap hands back new legs
 * and so a clean baseline, without anything having to remember to clear it.
 */
let delayWarnState = new WeakMap<Leg, DelayWarnState>()

/**
 * Drop every leg's warned-lateness baseline. Test-only — production lifetime is
 * the leg object.
 */
export function resetDelayAlerts(): void {
  delayWarnState = new WeakMap<Leg, DelayWarnState>()
}

/**
 * Check whether the transit leg the rider is currently on is running late
 * enough to warrant a heads-up.
 *
 * Real-data only: uses `progress.delay`, the measured GPS-vs-schedule lag on
 * the current leg.
 *
 * Re-alerts only when the number the rider was READ changes for the worse. The
 * id used to bucket the delay into five-minute steps and lean on a five-minute
 * `wasRecentlySent` window, which is a rate limit, not a fact: on 2026-09-01
 * ride 1 "METRO Orange Line is running about 3 min late" went out at 08:25:38,
 * 08:35:25 and 08:41:05 — three pushes, one fact, each one the moment the
 * window aged out with the delay still inside bucket 0. The rider's rule is
 * that notification copy is only the numbers they act on; a number they have
 * already been given is not one of them.
 */
export function checkDelayAlert(
  progress: TripProgress,
  currentLeg: Leg,
  sentNotifications: string[],
  /** Legs of the active itinerary, so the alert can tell it is still on one. */
  legs?: Leg[]
): NotificationEvent | null {
  if (!isTransitMode(currentLeg.mode)) return null

  // Never quote lateness at a rider who has arrived.
  //
  // `delay` is measured against the wall clock, so on a trip that is over it
  // just counts the time since: the 2026-08-31 18:52 session went 1489 s ->
  // 1911 s with the rider standing still at their destination. The tick that
  // latches arrival is the one tick this pass still runs on (handlePositionUpdate
  // quiesces only from the NEXT tick), and a re-mount onto a finished trip
  // rebuilds the session with `arrivedAt` unset — so the guard belongs here as
  // well as in the store. Same arrival rule as checkTripComplete, so the two can
  // never disagree about whether the trip is over.
  if (
    progress.status === 'completed' ||
    hasArrivedAtDestination(
      progress.overallProgress,
      progress.distanceToDestination
    )
  ) {
    return null
  }

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

  // The key is the fact — the minutes the rider is about to be read — not the
  // five-minute bracket the fact happens to sit in.
  const id = generateNotificationId('DELAY_ALERT', `${routeName}_${lateMin}`)

  if (wasRecentlySent(id, sentNotifications, 300000)) return null

  // Only a materially WORSE number is news. Hysteresis rather than a bare
  // inequality because delay swings a minute either way tick to tick, and
  // 3 -> 4 -> 3 -> 4 would be its own storm; and worsening-only because a bus
  // making up time needs no announcement.
  const previouslyWarned = delayWarnState.get(currentLeg)
  if (
    previouslyWarned &&
    lateMin < previouslyWarned.warnedLateMin + DELAY_REWARN_WORSEN_MINUTES
  ) {
    return null
  }
  delayWarnState.set(currentLeg, { warnedLateMin: lateMin })

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
 * Process all notification checks and return any that should be triggered.
 *
 * `turnCuesEnabled` is the rider's turn-by-turn switch for the leg being
 * checked — the global Settings default, overridden by a per-leg opt-in from
 * the trip sheet (see util/go-mode/turn-cue-settings). It gates the turn cues
 * ONLY; every other card here is about a bus the rider is going to miss or a
 * stop they are going to sail past, and none of those are theirs to silence.
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
  deviation?: DeviationAlertGate,
  turnCuesEnabled = true
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
      checkUpcomingTurn(
        progress,
        currentLeg,
        sentNotifications,
        turnCuesEnabled
      )
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

/**
 * The notifier's per-leg memory, in a shape that survives a page load.
 *
 * Three of the checks above hold their state on the leg OBJECT — a `WeakSet` of
 * legs whose entry card has gone out, and two `WeakMap`s of the number the
 * rider was last read. That is exactly right while the page lives: an itinerary
 * swap hands back new leg objects and so re-arms everything, and the whole map
 * is collectable when the trip ends.
 *
 * It is exactly wrong across a re-mount. The legs come back from storage as
 * fresh objects, so every latch reads empty, and the conditions they guard are
 * standing ones rather than edges: `currentLegIndex > previousLegIndex` holds
 * for as long as the rider is past leg 0 (and `session.lastTransitionedLegIndex`
 * is a module field that a re-mount resets to null, so `previousLegIndex` comes
 * back 0 — `actions/go-mode.ts:3735`), and a bus that is 3 min late is still
 * 3 min late one second after the app came back. The rider is therefore told
 * again everything they were told before: "Board METRO Orange Line", "running
 * about 3 min late", the connection they are about to miss.
 *
 * Leg INDEXES, not identities, because that is all storage can carry — and it
 * is the right key anyway, since a session is only ever restored onto the very
 * itinerary it was saved from.
 */
export interface NotificationLatches {
  /** Legs whose entry card has already gone out. */
  announcedLegIndexes: number[]
  /**
   * The `<cueIndex>_<stage>` keys `checkUpcomingTurn` has already announced on
   * each leg — the fourth object-keyed latch, and the one 6.21 left behind.
   *
   * Its exposure is narrower than the other three but real: already-PASSED
   * cues cannot re-fire (the check only ever announces a cue still ahead) and
   * a leg restored fresh starts pre-charged at STATIONARY_HOLD_TICKS, so what
   * a re-mount loses is the CURRENT cue — which re-announces once per mount,
   * on a phone that re-mounted twice in 41 s on 2026-08-31.
   */
  announcedTurnCuesByLeg: Record<number, string[]>
  /** The margin, in seconds, each connection warning last quoted. */
  connectionWarnedSlackSecondsByLeg: Record<number, number>
  /** The lateness, in minutes, the rider was last read for each leg. */
  delayWarnedLateMinByLeg: Record<number, number>
}

/**
 * Read the latches back out for saving. `WeakSet`/`WeakMap` cannot be walked,
 * but they can be asked about a key — and the legs are the keys.
 */
export function captureNotificationLatches(legs?: Leg[]): NotificationLatches {
  const latches: NotificationLatches = {
    announcedLegIndexes: [],
    announcedTurnCuesByLeg: {},
    connectionWarnedSlackSecondsByLeg: {},
    delayWarnedLateMinByLeg: {}
  }
  if (!Array.isArray(legs)) return latches
  legs.forEach((leg, index) => {
    if (!leg || typeof leg !== 'object') return
    if (announcedLegEntries.has(leg)) latches.announcedLegIndexes.push(index)
    // Only the announcement keys travel, never `slowTicks`: the stationary
    // hold is about the rider's speed history in THIS page's ticks, and a
    // restored leg is meant to start pre-charged.
    const turn = turnState.get(leg)
    if (turn && turn.announced.size > 0) {
      latches.announcedTurnCuesByLeg[index] = Array.from(turn.announced)
    }
    const delay = delayWarnState.get(leg)
    if (delay) latches.delayWarnedLateMinByLeg[index] = delay.warnedLateMin
    const connection = connectionWarnState.get(leg)
    if (connection) {
      latches.connectionWarnedSlackSecondsByLeg[index] =
        connection.warnedSlackSeconds
    }
  })
  return latches
}

/**
 * Re-key a saved set of latches onto the restored itinerary's leg objects, so a
 * resumed trip carries on from what the rider has already been told.
 *
 * Additive on purpose: it only ever marks legs as already-announced, never
 * un-marks one. A restore cannot therefore make the app say MORE than it would
 * have — the failure mode of a wrong index is silence about one leg, not a
 * second copy of a card.
 */
export function restoreNotificationLatches(
  legs: Leg[] | undefined,
  latches: Partial<NotificationLatches> | null | undefined
): void {
  if (!Array.isArray(legs) || !latches) return
  const legAt = (index: unknown): Leg | undefined => {
    const i =
      typeof index === 'string' ? parseInt(index, 10) : (index as number)
    return Number.isInteger(i) ? legs[i as number] : undefined
  }
  ;(latches.announcedLegIndexes || []).forEach((index) => {
    const leg = legAt(index)
    if (leg) announcedLegEntries.add(leg)
  })
  Object.entries(latches.announcedTurnCuesByLeg || {}).forEach(
    ([index, cueKeys]) => {
      const leg = legAt(index)
      if (!leg || !Array.isArray(cueKeys)) return
      // Additive, like the rest of this function: `turnStateFor` mints the
      // leg's state pre-charged at STATIONARY_HOLD_TICKS, and adding keys can
      // only make the app say LESS than it otherwise would.
      const state = turnStateFor(leg)
      cueKeys.forEach((key) => {
        if (typeof key === 'string') state.announced.add(key)
      })
    }
  )
  Object.entries(latches.delayWarnedLateMinByLeg || {}).forEach(
    ([index, warnedLateMin]) => {
      const leg = legAt(index)
      if (leg && typeof warnedLateMin === 'number') {
        delayWarnState.set(leg, { warnedLateMin })
      }
    }
  )
  Object.entries(latches.connectionWarnedSlackSecondsByLeg || {}).forEach(
    ([index, warnedSlackSeconds]) => {
      const leg = legAt(index)
      if (leg && typeof warnedSlackSeconds === 'number') {
        connectionWarnState.set(leg, { warnedSlackSeconds })
      }
    }
  )
}
