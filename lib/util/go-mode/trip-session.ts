import type { StopCountLatch } from './next-stop'
/**
 * The mutable state of one trip.
 *
 * All of this used to be 21 separate module-level `let`s in actions/go-mode.ts,
 * torn down by hand in a 92-line `endGoMode`: add a variable, remember to add a
 * reset line, or it leaks into the rider's next trip. The iOS shell is a
 * WKWebView that is never reloaded between trips, so "leaks into the next trip"
 * means until the rider force-quits the app.
 *
 * Gathering it here makes the lifetime explicit — `session = createTripSession()`
 * is the whole teardown — and makes it inspectable and injectable rather than
 * invisible to the devtools, the debug log and every test.
 *
 * What is NOT here, on purpose: `lastFixAtMs`, `simulationSpeedMultiplier` and
 * `replayTrackedRouteId` deliberately outlive a trip today. They stay module
 * scoped in actions/go-mode.ts rather than change behaviour silently.
 */
import type { BoardStopDwell, EarlyAlightWatch } from './riding'
import type { DepartureBaselineState } from './departure-drift'
import type { DestinationProgressState } from './destination-progress'
import type { MissedBusAttempt } from './missed-bus-recovery'
import type { PacingCardState } from './pacing-card'
import type { RiderSpeedAnchorBucket, RiderSpeedSample } from './rider-speed'
import type { TimedSimulationPoint } from './geometry'

export interface TripSession {
  /**
   * The one-way arrival dwell, armed from the WALL CLOCK rather than from the
   * position tick. `AUTO_END_AFTER_ARRIVAL_MS` used to be checked in the
   * arrived branch of handlePositionUpdate, which meant a phone that stopped
   * producing fixes after arrival never evaluated it: on 2026-09-17 the rider
   * went indoors, `POSITION_FETCHING` stopped being answered at 21:42:43, and
   * the finished trip was still open 7m24s later (backlog 13.5). A dwell is a
   * statement about time passing, so it is measured by a timer.
   *
   * Never armed during GPS simulation or replay — those run on the simulated
   * clock (`getCurrentTime`), which a wall-clock timeout knows nothing about.
   */
  autoEndTimeoutId: ReturnType<typeof setTimeout> | null

  /**
   * How long the rider has waited, continuously, at the boarding stop of the
   * leg the matcher is on. The board gate's one non-instantaneous input — see
   * BOARD_STOP_DWELL_MIN_MS in riding.ts.
   */
  boardStopDwell: BoardStopDwell | null

  /**
   * Closest approach to the destination so far, and how many re-plans have gone
   * out since it last improved. The only thing in Go Mode that remembers
   * distanceToDestination across ticks — see destination-progress.ts for the
   * 8/28 ride that needed it.
   */
  destinationProgress: DestinationProgressState | null

  /**
   * When this deviation was last dealt with — the rider told, or the drift
   * quietly re-planned around. Held here, NOT in `sentNotifications`, because
   * an itinerary swap wipes the deviation ids out of that list (START_GO_MODE,
   * reducers/go-mode.ts) and the swap is the re-plan the alert itself asked
   * for. That is how a 120 s window produced cards 55 s and 108 s apart on
   * 2026-08-28. Survives a swap on purpose; a new trip resets it with the rest
   * of the session.
   */
  deviationHandledAtMs: number | null

  /**
   * The rider-versus-vehicle divergence watch behind the early-alight rule —
   * see EARLY_ALIGHT_MIN_MS in riding.ts. Held here for the same reason
   * boardStopDwell is: "have these two been drifting apart" cannot be answered
   * by one fix.
   */
  earlyAlightWatch: EarlyAlightWatch | null

  /** The boarded-earlier replan's retry bookkeeping, per boarding. */
  earlyBoardReplan: {
    attempts: number
    key: string
    lastAtMs: number
  } | null

  /**
   * When the leg geometry last moved under the rider: an itinerary swap or a
   * leg transition. Stamped in exactly the two places that already null
   * `prevDistanceFromRoute`, for the same reason — the rider's relationship to
   * the line has just been redrawn, and for a moment being "off route" is a
   * statement about the app, not about them. See DEVIATION_GEOMETRY_SETTLE_MS.
   */
  geometryChangedAtMs: number | null

  /** GPS polling interval (replaces the old window.__goModeIntervalId). */
  gpsPollingIntervalId: ReturnType<typeof setInterval> | null

  gpsSimulationTimeoutId: ReturnType<typeof setTimeout> | null

  /**
   * Native fix-staleness watchdog. iOS occasionally wedges a background
   * location watcher without erroring (7/29: minutes of silence mid-ride while
   * the trip state aged in place); the only recovery is tearing the watcher
   * down and starting a new one.
   */
  gpsWatchdogIntervalId: ReturnType<typeof setInterval> | null

  /**
   * Timestamp of the last fix ACCEPTED after arrival, for the idle-cadence
   * gate in handlePositionUpdate. Null until the rider arrives.
   */
  lastArrivedFixMs: number | null

  /**
   * Lets the auto-anchor keep chasing the live feed while the current
   * departure override is its own.
   */
  lastAutoAnchorMs: number | null

  /**
   * The last live record of the BOARDING trip's own vehicle, carried across a
   * vehicle poll that came back empty.
   *
   * REALTIME_VEHICLE_POSITIONS_RESPONSE `$set`s the route's vehicle list
   * (create-otp-reducer :933), so a response carrying zero vehicles erases
   * every vehicle the app knew about for that route until the next poll
   * refills it. On the 2026-09-21 17:04 ride 15 of 124 polls for route 1:904
   * came back empty — and MISSED_BUS fired 0.9 s after two of them (17:05:45
   * after the 17:05:44 empty poll, 17:06:06 after the 17:06:05 one) while the
   * bus was 2.5 km north with the boarding stop as its next stop. Every other
   * tick in that window carried 12 vehicles.
   *
   * Only the boarding trip's record is kept, only here, and its age is
   * recomputed from the feed's own `seconds` on every tick, so a carried
   * record never claims to be fresher than it is; `seenAtMs` bounds it as well
   * for the vehicles whose feed publishes no timestamp at all.
   */
  lastBoardVehicle: {
    seenAtMs: number
    tripId: string
    vehicle: any
  } | null

  /**
   * The boarding being watched for departure jumps, and what the rider was last
   * told about it (see departure-drift.ts). Must survive a tick, never a trip.
   */
  lastDepartureBaseline: DepartureBaselineState | null

  /**
   * Wall-clock throttle for re-polling live transit leg times off
   * GTFS-realtime. 0 per trip so the first tick fetches immediately.
   */
  lastLiveLegTimesAt: number

  /** What the sticky pacing card last showed. Null when no card is showing. */
  lastPacingCard: PacingCardState | null

  /** Debounce for the quiet access-leg replan (bike/walk deviation). */
  lastQuietReplanAt: number

  /**
   * Wall-clock ms of the last reroute snapshot that actually fetched, so the
   * stretched cadence used while the rider is settled aboard has something to
   * measure against. 0 before the first capture of the trip.
   */
  lastRerouteSnapshotAt: number

  /**
   * A leg transition is side-effectful (vehicle tracking, GPS interval restart,
   * departure-override reset), so it must run once per leg. The route match is
   * recomputed from raw position every tick and cannot carry that fact.
   */
  lastTransitionedLegIndex: number | null

  /**
   * Identity (leg + cue index) of the turn currently on the sticky card, so it
   * is re-posted only when the turn itself changes. Null when none is showing.
   */
  lastTurnCardKey: string | null

  /**
   * Identifies the lock-screen Live Activity this Go Mode session owns, so a
   * card left running by a previous session (a page reload mid-trip: the web
   * layer restarts, the OS's activity does not) is recognised as somebody
   * else's and ended rather than updated. Minted per session, never persisted
   * — a resumed trip is a NEW card by design. Null when no card was ever
   * started. See util/go-mode/live-activity.ts; backlog 8.10.
   */
  liveActivityTripId: string | null

  /**
   * The rider's explicit departure pick must never be fought by the
   * auto-anchor, so a manual selectDeparture locks auto-anchoring off for the
   * current boarding.
   */
  manualDepartureLock: boolean

  /**
   * When route matching went on hold because a transit leg's geometry is
   * unusable (see geometry-trust.ts). Null while matching normally; used to
   * log the hold once and its duration when it lifts.
   */
  matchHeldSinceMs: number | null

  /**
   * What the rider was last told about an AMBIGUOUS missed bus, as
   * `<departureMs>:found|none`, or null while there is nothing outstanding.
   *
   * Two jobs. It latches the one push and the one hand-off to the planner, so a
   * settled re-plan is not re-announced on every tick — and, because the answer
   * is part of the key, a retry that finally finds something IS announced,
   * while a repeat of the same "nothing" is not. And it is the record that
   * there is a claim to take back if the bus turns out not to have been missed.
   *
   * A definitive miss does not use it: that one auto-updates the trip and says
   * so at the moment it happens.
   */
  missedBusNoticeKey: string | null

  /** Retry bookkeeping for the missed departure being recovered from. */
  missedBusRerouteAttempt: MissedBusAttempt | null

  /**
   * A single wild GPS fix (urban multipath) can put the matched distance
   * kilometres off-route for one tick — 5836 m mid-ride on 7/22 while riding
   * the bus dead on its line. Deviation handling only acts on a distance that
   * exceeded reality on the PREVIOUS tick too.
   */
  prevDistanceFromRoute: number | null

  /**
   * Quiet access-leg replan timestamps inside the burst window, so a cooldown
   * that now scales down with leg length still cannot become a replan storm.
   */
  quietReplanHistory: number[]

  /**
   * Quiet access-leg replans that keep coming back empty are counted but settle
   * silently; the streak is bookkeeping for the debug log.
   */
  quietReplanMissStreak: number
  /** Reroute-snapshot capture interval (recording sessions only). */
  rerouteSnapshotIntervalId: ReturnType<typeof setInterval> | null

  /**
   * A round-trip return refresh is out. Post-arrival ticks run every 30 s and
   * `shouldRefreshReturnPlan` stays true for the whole 15-minute window until
   * the answer lands in the store, so without this the first tick's fetch and
   * the next twenty-nine all go out together. Cleared by the fetch settling —
   * and by endGoMode, for free, with the rest of the session.
   */
  returnRefreshInFlight: boolean

  /**
   * The last tick's classifyMissedBus verdict for the upcoming boarding, so
   * the NEXT tick can put it on TripProgress for the current-leg card's hold
   * (departure-anchor.resolveCardDeparture). The classifier runs well after
   * progress is dispatched within a tick, and a one-tick lag on a release
   * decision that already waits minutes of grace costs nothing.
   */
  riderBoardingMiss: { definitive: boolean; effectiveBoardMs: number } | null

  /**
   * When the rider last tapped "Not on the bus" on the trip sheet. Holds the
   * automatic, evidence-free half of the board gate off for a few minutes so
   * the matcher cannot immediately put them back aboard — see
   * boarding-confirmation.ts. Trip state, never trip-crossing.
   */
  riderDeniedBoardingAtMs: number | null

  /**
   * The sparse ride-level companion to riderSpeedSamples: one peak moving fix
   * per minute of riding, fed from the same gate. It is what puts a floor under
   * the short-window median so a downtown crawl cannot time a whole access leg
   * — see rider-speed.ts (backlog 16.1).
   */
  riderSpeedAnchor: RiderSpeedAnchorBucket[]

  /**
   * Recent ground speeds off the rider's own fixes while they are on a bike
   * leg, for the observed-bikeSpeed estimate a replan query carries. See
   * rider-speed.ts — this is a rolling estimate precisely because a single
   * instantaneous sample is worse than no sample at all.
   */
  riderSpeedSamples: RiderSpeedSample[]

  /** Epoch ms — the "current time" in simulation-land. */
  simulatedTimeMs: number

  simulationActive: boolean

  simulationCoords: TimedSimulationPoint[]

  simulationPointIndex: number

  /**
   * Signature of a plan that has just been INSTALLED and whose origin has not
   * yet been checked against the rider's position (backlog 12.13).
   *
   * Armed by `beginGoMode`, cleared by the first look that had a fix to look
   * with — `recoverStaleStartOrigin` may be reached before any fix exists, so
   * "armed" and "answered" have to be separate states. Keyed on the plan rather
   * than latched with a boolean so a SECOND stale tap arms the question again.
   *
   * Arming is what scopes the question to an installation. A rider halfway
   * along their access leg is legitimately far from their own plan's origin —
   * they walked away from it — so the same check asked on an ordinary tick
   * would re-plan a trip that is going perfectly well.
   */
  staleStartOriginPending: string | null

  /** Monotonic floor for stopsRemaining — see latchStopsRemaining. */
  stopCountLatch: StopCountLatch | null

  /** Vehicle-position polling interval. */
  vehiclePositionIntervalId: ReturnType<typeof setInterval> | null

  /** The visibilitychange listener installed for this trip, for removal. */
  visibilityChangeHandler: (() => void) | null
}

/** A trip's state at its first GPS fix. */
export function createTripSession(): TripSession {
  return {
    autoEndTimeoutId: null,
    boardStopDwell: null,
    destinationProgress: null,
    deviationHandledAtMs: null,
    earlyAlightWatch: null,
    earlyBoardReplan: null,
    geometryChangedAtMs: null,
    gpsPollingIntervalId: null,
    gpsSimulationTimeoutId: null,
    gpsWatchdogIntervalId: null,
    lastArrivedFixMs: null,
    lastAutoAnchorMs: null,
    lastBoardVehicle: null,
    lastDepartureBaseline: null,
    lastLiveLegTimesAt: 0,
    lastPacingCard: null,
    lastQuietReplanAt: 0,
    lastRerouteSnapshotAt: 0,
    lastTransitionedLegIndex: null,
    lastTurnCardKey: null,
    liveActivityTripId: null,
    manualDepartureLock: false,
    matchHeldSinceMs: null,
    missedBusNoticeKey: null,
    missedBusRerouteAttempt: null,
    prevDistanceFromRoute: null,
    quietReplanHistory: [],
    quietReplanMissStreak: 0,
    rerouteSnapshotIntervalId: null,
    returnRefreshInFlight: false,
    riderBoardingMiss: null,
    riderDeniedBoardingAtMs: null,
    riderSpeedAnchor: [],
    riderSpeedSamples: [],
    simulatedTimeMs: 0,
    simulationActive: false,
    simulationCoords: [],
    simulationPointIndex: 0,
    staleStartOriginPending: null,
    stopCountLatch: null,
    vehiclePositionIntervalId: null,
    visibilityChangeHandler: null
  }
}
