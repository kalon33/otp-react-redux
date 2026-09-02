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
import type { BoardStopDwell } from './riding'
import type { DepartureBaselineState } from './departure-drift'
import type { DestinationProgressState } from './destination-progress'
import type { MissedBusAttempt } from './missed-bus-recovery'
import type { PacingCardState } from './pacing-card'
import type { RiderSpeedSample } from './rider-speed'
import type { TimedSimulationPoint } from './geometry'

export interface TripSession {
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
    boardStopDwell: null,
    destinationProgress: null,
    deviationHandledAtMs: null,
    earlyBoardReplan: null,
    geometryChangedAtMs: null,
    gpsPollingIntervalId: null,
    gpsSimulationTimeoutId: null,
    gpsWatchdogIntervalId: null,
    lastArrivedFixMs: null,
    lastAutoAnchorMs: null,
    lastDepartureBaseline: null,
    lastLiveLegTimesAt: 0,
    lastPacingCard: null,
    lastQuietReplanAt: 0,
    lastRerouteSnapshotAt: 0,
    lastTransitionedLegIndex: null,
    lastTurnCardKey: null,
    manualDepartureLock: false,
    matchHeldSinceMs: null,
    missedBusRerouteAttempt: null,
    prevDistanceFromRoute: null,
    quietReplanHistory: [],
    quietReplanMissStreak: 0,
    rerouteSnapshotIntervalId: null,
    riderSpeedSamples: [],
    simulatedTimeMs: 0,
    simulationActive: false,
    simulationCoords: [],
    simulationPointIndex: 0,
    stopCountLatch: null,
    vehiclePositionIntervalId: null,
    visibilityChangeHandler: null
  }
}
