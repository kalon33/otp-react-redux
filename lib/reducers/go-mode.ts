import { handleActions } from 'redux-actions'
import type { Itinerary } from '@opentripplanner/types'

import {
  ADD_NOTIFICATION,
  ANSWER_ONBOARD_STOP_CHOICE,
  AUTO_SWITCH,
  BEGIN_ONBOARD_FLOW,
  CLEAR_FASTER_ROUTE_OFFER,
  CLEAR_ONBOARD,
  CLEAR_REROUTE,
  CLEAR_RIDING,
  CLEAR_VEHICLE_MATCH,
  CLOSE_ONBOARD_PREVIEW,
  CONFIRM_VEHICLE,
  DISMISS_BOARDING_PROMPT,
  OPEN_CHOOSE_BUS,
  OPEN_ONBOARD_PREVIEW,
  PAUSE_GPS_SIMULATION,
  REPAIR_LEG_GEOMETRY,
  RESUME_GPS_SIMULATION,
  SET_ARRIVED,
  SET_AUTO_MODE,
  SET_AUTO_UNDO,
  SET_BOARDING_SEARCH_FAILED,
  SET_BOARDING_SEARCHING,
  SET_CHOOSE_BUS_ERROR,
  SET_DEPARTURE_OVERRIDE,
  SET_EARLY_ALIGHT,
  SET_FASTER_ROUTE_OFFER,
  SET_GO_MODE_ACTIVE_LEG,
  SET_GO_MODE_BACKGROUNDED,
  SET_LEG_TURN_CUES,
  SET_LIVE_LEG_TIMES,
  SET_MAP_FOLLOW,
  SET_NEAR_DESTINATION,
  SET_NOTIFICATION_CONFIG,
  SET_ONBOARD_CONFIRMING,
  SET_ONBOARD_RESULT,
  SET_ONBOARD_STATUS,
  SET_ONBOARD_STOP_CHOICE,
  SET_ONBOARD_TRIP,
  SET_ONBOARD_VEHICLE,
  SET_PLAN_STOP_OFFER,
  SET_REROUTE_RESULT,
  SET_RETURN_COUNTDOWN,
  SET_RIDING,
  SET_ROUND_TRIP,
  SET_TRACKING_ERROR,
  SET_TRANSIT_LEG_ENTERED,
  SET_TURN_CUE_DEFAULT,
  SHOW_BOARDING_PROMPT,
  START_GO_MODE,
  START_GPS_SIMULATION,
  START_ONBOARD_OPTIMIZE,
  START_REROUTE,
  STOP_GO_MODE,
  STOP_GPS_SIMULATION,
  TOGGLE_MAP_FOLLOW,
  TRANSITION_LEG,
  UPDATE_NEARBY_VEHICLES,
  UPDATE_POSITION,
  UPDATE_PROGRESS,
  UPDATE_ROUTE_MATCH,
  UPDATE_SIMULATION_PROGRESS,
  UPDATE_TRACKING_INTERVAL,
  UPDATE_VEHICLE_MATCH
} from '../actions/go-mode'
import {
  AUTO_ARM_TRIGGER,
  CLEAR_AUTO_ARM,
  SET_AUTO_ARM
} from '../util/go-mode/auto-arm'
import { AUTO_OFF } from '../util/go-mode/auto-switch'
import {
  DEFAULT_TURN_CUE_SETTINGS,
  TurnCueSettings
} from '../util/go-mode/turn-cue-settings'
import { FIX_ACCURACY_MAX_M } from '../util/go-mode/transit-trust'
import { goModeClockMs } from '../util/go-mode/clock'
import {
  ridingFactIsEvidenced,
  ridingKeptTooLong
} from '../util/go-mode/riding'
import { sameOnboardStop } from '../util/go-mode/onboard-stops'
import type { AutoArm } from '../util/go-mode/auto-arm'
import type { AutoState } from '../util/go-mode/auto-switch'
import type {
  DepartureOverrideSource,
  LiveLegTime,
  RidingState
} from '../util/go-mode/types'
import type { EarlyAlightRecord } from '../util/go-mode/riding'
import type { FasterRouteOffer } from '../util/go-mode/faster-route-offer'
import type { MultiStopPlan } from '../util/multi-stop'
import type {
  NearbyVehicleOption,
  VehicleMatchResult
} from '../util/go-mode/vehicle-matching'
import type { NearDestination } from '../util/go-mode/arrival-dwell'
import type { NotificationEvent } from '../util/go-mode/notification-service'
import type { OnboardStop } from '../util/go-mode/onboard-stops'
import type {
  ReturnCountdownState,
  RoundTripPlan
} from '../util/go-mode/round-trip'
import type { RouteMatchResult } from '../util/go-mode/position-matching'
import type { TripProgress } from '../util/go-mode/progress-calculator'

export interface SimulationState {
  pointIndex: number
  speedMultiplier: number
  status: 'idle' | 'running' | 'paused'
  totalPoints: number
}

/** The live vehicle the rider confirmed they are already aboard. */
export interface OnboardVehicle {
  label: string | null
  nextStopId: string | null
  routeId: string | null
  tripId: string | null
  vehicleId: string
}

/** One candidate alight stop being evaluated by the onboard optimizer. */
export interface OnboardCandidate {
  busArrivalEpoch: number
  realtime: boolean
  stopId: string
  stopName: string
}

/** The chosen best stop to get off, with its remaining-journey itinerary. */
export interface OnboardAlightOption {
  /** Where `displayItinerary` ACTUALLY puts the rider down, when that is not
   * `stopId` — set by decorateAlightOptions when the onward plan opens with the
   * boarded trip continuing and the legs merge into one longer ride. The list
   * captions the row with this, because it is the stop a tap guides to. */
  alightStopId?: string
  alightStopName?: string
  busArrivalEpoch: number
  /** The full trip a tap starts: current-bus leg + onward legs. What the
   * results list renders, so the display matches the outcome exactly. */
  displayItinerary?: Itinerary
  /** The onward plan from the alight stop (ranking input). */
  itinerary: Itinerary
  realtime: boolean
  stopId: string
  stopName: string
}

/**
 * The option the rider is LOOKING AT — a separate preview screen over the
 * options list, which stays alive underneath it (17.1).
 *
 * Before this existed, every tap on a row WAS the commit: the row's
 * `onClickCapture` went straight to `confirmOnboardAlightStop`, whose first
 * act was `clearOnboard()` — and `alightOptions` is the only copy of the list,
 * so there was no back. On 2026-09-15 15:56:13 the rider tapped a row to look
 * at it, the trip started, the list was gone, and recovering it cost five
 * fresh OTP plan requests at 15:57:15-19. Their note: *"Again: I just want to
 * view alternatives ... but just viewing switched and then other options are
 * gone"* — the second time they had asked.
 *
 * So: opening this changes nothing but this field, and closing it clears
 * nothing but this field. Commit happens only from the preview's own Confirm.
 */
export interface OnboardAlightPreview {
  /** Which control opened it — the row itself, or the same-shape drill-down.
   * Recorded so the debug stream says what the rider touched (17.11). */
  control: 'row' | 'variant'
  openedAtMs: number
  option: OnboardAlightOption
}

/**
 * "I'm already on the bus" flow: discover the live vehicle the rider is on,
 * fetch its schedule, and find the best stop to alight to finish the trip.
 * Distinct from reRoute (a mid-trip swap of an already-active itinerary).
 */
export interface OnboardState {
  alightOptions: OnboardAlightOption[]
  /**
   * How many of `candidates` actually came back with a plan by the time the
   * options below were ranked. Null when unknown (nothing has optimized yet).
   *
   * Since 2026-09-02 the optimizer ranks whatever answered by its deadline
   * rather than hanging on the slowest candidate (4.1) — a strictly better
   * trade, but it means a partial answer and a whole answer looked identical
   * on screen. This is what lets AlightRecommendation say "still checking N
   * more stops" instead of presenting two of five as the whole list.
   */
  answeredCandidates: number | null
  bestAlightStop: OnboardAlightOption | null
  candidates: OnboardCandidate[]
  /**
   * Epoch ms the preview's Confirm started re-checking the chosen stop
   * against where the rider is now (64.1); null when it is not. While set the
   * Confirm button is disabled under "Finding the best stop to get off…" and
   * a second tap does nothing. Back (CLOSE_ONBOARD_PREVIEW) and CLEAR_ONBOARD
   * drop it, and a re-check that comes back to find it gone or changed stands
   * down — the rider has moved on.
   */
  confirmingAtMs: number | null
  /**
   * Candidates that settled with no plan at all and have nothing more coming —
   * the request errored or timed out and its retry did too. Null when unknown.
   *
   * Counted apart from `pendingCandidates` because the two mean opposite things
   * to the rider ("wait" versus "this stop has no answer") and because on
   * 2026-09-15 15:54:19 three of five candidates failed, `pendingCandidates`
   * was 0, and the panel — which only ever read that number — presented two of
   * five stops as the answer with nothing saying so (backlog 17.3).
   */
  failedCandidates: number | null
  /** The route the rider already chose for the leg after this bus, captured
   * when the flow opened (BEGIN_ONBOARD_FLOW nulls activeItinerary, so it
   * cannot be re-derived later). Ranks its options up, never filters. */
  keepRouteId: string | null
  /**
   * The rider's added stops the bus has already left behind, while the card
   * asks "still go there, or skip it?" (63.1, 2026-10-20 Q2 = C); null when
   * nothing is being asked. Only ever stops the rider has not answered for.
   */
  passedStops: OnboardStop[] | null
  /**
   * Candidates whose onward plan was still in flight when the deadline fired,
   * so a straggler could still land and improve the list. Rejections are NOT
   * counted here — those are over. Null when unknown.
   */
  pendingCandidates: number | null
  /** Set while the rider is previewing one option; null on the list itself.
   * Never cleared by a result landing — a straggler folding into the list
   * behind the preview must not close it. */
  preview: OnboardAlightPreview | null
  /**
   * Epoch ms (wall clock) the options on screen were ranked — set by the
   * optimizer's SET_ONBOARD_RESULT (64.1). The Confirm uses it to tell a list
   * built minutes ago from one built just now: on 2026-10-19 16:35:17 the
   * rider confirmed a 69 s-old list with the bus already past its stop, and on
   * 2026-10-20 08:32:53 a 12.8 min-old one. Null when unknown — a payload that
   * did not say — which never counts as stale.
   */
  resultAtMs: number | null
  status:
    | 'idle'
    | 'discovering'
    | 'awaiting-selection'
    | 'fetching-schedule'
    /** The added-stop card, before any candidate is asked (63.1). */
    | 'added-stop-choice'
    | 'optimizing'
    | 'ready'
    | 'error'
  /**
   * Where the added-stop card was put up from, so its answer resumes the
   * right step: 'list' — the onboard flow, before the get-off list was asked
   * for; 'confirm' — the preview's Confirm (the preview stays underneath).
   * Null when no card is up.
   */
  stopChoiceFor: 'confirm' | 'list' | null
  /**
   * The search's added stops this flow is taking the rider through, with
   * their stays (63.1), captured at BEGIN_ONBOARD_FLOW — a stop skipped on
   * the card is removed, a stop kept is marked `kept`. Null when the flow was
   * not opened by BEGIN_ONBOARD_FLOW (the mid-ride "Pick another stop" list,
   * replanFromAboard), which leaves the live trip's own plan as it was.
   */
  stops: OnboardStop[] | null
  /**
   * How many candidate stops this optimize asked about — the denominator for
   * the three counts above. `candidates.length` is the same number while the
   * run that produced the options is the current one; this is what it was when
   * the options were ranked.
   */
  totalCandidates: number | null
  trip: any | null
  vehicle: OnboardVehicle | null
}

export interface GoModeState {
  activeItinerary: Itinerary | null

  /**
   * The trip the rider most recently GOT OFF, kept until they assert a vehicle
   * again. `riding` is cleared on alighting but a confirmed vehicleMatch can
   * outlive it (STOP_GO_MODE and session restore both preserve one on purpose),
   * and on 8/9 that stale assertion put the rider back on the bus they had
   * just left. Presence here means "not evidence of being aboard".
   */
  alightedFrom: { tripId: string | null; vehicleId: string | null } | null

  /**
   * "Start when I leave" (65.2, cycle 36 B4): a trip armed to start in Auto
   * when the rider heads out, with Go Mode itself still off. Null when none.
   * Cleared by its own start, a cancel, its 2 h lapse — and by any trip that
   * starts some other way (START_GO_MODE, BEGIN_ONBOARD_FLOW).
   */
  arm: AutoArm | null

  /** Epoch ms when trip progress first read completed; null while en route.
   * While set, position ticks quiesce and the arrival card is shown. */
  arrivedAt: number | null

  /**
   * The schedule delay measured on the ARRIVAL tick, in seconds — the last
   * measurement that meant anything, held so every later tick can quote it.
   *
   * `computeCurrentDelay` measures the schedule against the wall clock, so on a
   * finished trip it just counts the time since. The tick already refuses to
   * re-measure (actions/go-mode.ts), but it did so by carrying the PREVIOUS
   * tick's `progress.delay` forward, and `progress` is GPS-derived state that
   * `session-persistence` deliberately does not save: a re-mount therefore came
   * back with `arrivedAt` restored and `progress` null, re-measured once against
   * the wall clock, and froze THAT — 534.7 s where the arrival measured 495.99 s
   * on the 2026-09-01 ride, and unbounded on a round trip, whose session
   * legitimately outlives the outbound arrival by hours.
   *
   * Recorded here instead so the fact travels with the trip.
   */
  arrivedDelay: number | null

  /**
   * Auto mode (65.2, cycle 36 B2): on, which preset, the no-tap switches made
   * this trip, the route sets it has left or undone, and the Undo on the card.
   * OFF at every new trip — START_GO_MODE that starts one (not a swap within
   * it), BEGIN_ONBOARD_FLOW and STOP_GO_MODE — and kept across every swap
   * within the trip (its own switch is one). The Undo goes with any swap.
   */
  auto: AutoState

  boardingPrompt: {
    /**
     * The sheet was opened from "On a different bus?" on the waiting or
     * access card (51.1), not by the boarding flow: it lists live buses from
     * every nearby route plus route badges and a route-number box, and a pick
     * sets the riding fact and re-plans from that bus. On 2026-10-13 the rider
     * boarded a 546 the plan did not hold and the app had no way to be told.
     */
    chooseBus?: boolean
    /** Why the last pick in that mode could not be resolved (51.1). */
    chooseBusError?: { kind: 'no-route' | 'no-trip'; route: string } | null
    lastDismissedAt: number | null
    /**
     * The last vehicle search for this prompt FAILED — the feed reads did not
     * answer — as opposed to honestly finding nothing nearby. Without this the
     * two were indistinguishable on screen, and on 2026-09-15 the rider read a
     * four-minute OTP outage (17.8: five REALTIME_VEHICLE_POSITIONS_ERRORs,
     * every one a 20 s timeout) as the app losing their bus. Drives the
     * sheet's error line and its retry (17.5); the 2026-08-31 sighting is
     * written up at util/go-mode/alight-optimizer.ts:618 — "no state anywhere
     * said the search had failed".
     */
    searchFailed: boolean
    /**
     * A vehicle search is running for this prompt and no poll has been
     * compared yet. The sheet says so instead of "No buses detected nearby":
     * on 2026-09-13 11:36:24 the rider tapped "I'm on the bus" from a bike leg
     * — where nothing had ever written `nearbyVehicles` — and read the empty
     * list as an answer about the train they were sitting on.
     */
    searching: boolean
    shown: boolean
    transitLegEnteredAt: number | null
  }

  departureOverride: number | null

  /**
   * Who chose `departureOverride` — see DepartureOverrideSource (12.15).
   * Always written with the value and cleared with it, so the pair is never
   * half-set; null exactly when there is no override.
   */
  departureOverrideSource: DepartureOverrideSource | null

  /**
   * The RUN `departureOverride` names, when the pick came off a departure row
   * that carried a trip id (backlog 29.3). The card and the tick follow that
   * run's live time instead of freezing the tapped minute. Written and cleared
   * with the value; null for an anchor pick or a session saved before 29.3.
   */
  departureOverrideTripId: string | null

  /**
   * The rider got off a bus EARLY, at a stop that is still on the ridden leg's
   * route (8.11). Held because nothing else in the trip's shape says so: the
   * matcher stays on the transit leg (they are standing on its geometry), so
   * `routeMatch.legIndex` still names the bus they left, and the boarding
   * alerts and their vehicle poll would go on asking about that leg. While
   * this is set, both read the NEXT transit leg instead.
   *
   * Cleared by anything that says the rider is aboard something again
   * (SET_RIDING, CONFIRM_VEHICLE) and by transitioning past the leg it names.
   */
  earlyAlight: EarlyAlightRecord | null

  /**
   * A trip through the rider's stops (backlog 43.1), guided one segment at a
   * time: `activeItinerary` is `segments[index]`, and arriving at the end of
   * any segment but the last is a pause at a stop, not the end of the trip —
   * no auto-end; the arrival card offers the next segment. Null for every
   * ordinary trip. See util/multi-stop.ts.
   */
  /**
   * The background "faster route available" offer on screen (56.1, cycle 25
   * B2), or null. ONE card, updated in place while later checks still see the
   * same route, replaced by a better one, and gone when its boarding passes,
   * when a later check no longer sees it, or when the rider answers it.
   * `kind` is `faster` | `lessBike` off the bus; `aboard` is the get-off
   * offer's (B4). START_GO_MODE and STOP_GO_MODE clear it: a new plan has not
   * been compared with anything yet. Never applied without the rider's tap.
   */
  fasterRoute: FasterRouteOffer | null

  isActive: boolean

  /** Live (or schedule-fallback) transit-leg times, keyed by leg index. Kept
   * fresh mid-ride by refreshLiveLegTimes; consumed by the trip overview. */
  liveLegTimes: Record<number, LiveLegTime>

  multiStop: MultiStopPlan | null

  /**
   * When the rider came within ARRIVAL_RADIUS_M of a bike or walking finish,
   * and which destination that was — the one-minute dwell that arrives a
   * rider who never reads inside 40 m (backlog 12.17; util/go-mode/
   * arrival-dwell). Null when not near. Saved with the session, like
   * `arrivedAt`, so a relaunch at the door does not restart the minute.
   */
  nearDestination: NearDestination | null

  notifications: {
    enabled: boolean
    recentNotifications: NotificationEvent[]
    sentNotifications: string[]
    soundEnabled: boolean
    vibrationEnabled: boolean
  }

  onboard: OnboardState

  /**
   * The trip origin captured when Go Mode began. A mid-trip re-route replaces
   * currentQuery.from with the rider's GPS position ("Current location"); this
   * lets endGoMode restore the origin the rider started with on exit.
   */
  originalFrom: any

  /**
   * "Pick another stop" (54.1, rider's Q4 = A). Set when "I'm on the bus" met
   * a current riding fact on the plan's own train and went straight to
   * guidance for the plan's stop instead of the get-off list; names the trip
   * so the button shows only while the rider is on that ride. START_GO_MODE
   * clears it (a new plan has not made that choice).
   */
  planStopOffer: { tripId: string } | null

  progress: TripProgress | null

  reRoute: {
    // Apply the best result without asking (definitive missed bus).
    autoApply: boolean

    /**
     * What the last settled re-plan actually found, ranked as
     * collectRerouteCandidates left it (capped at 5). Empty while searching,
     * and empty for a search that came back with nothing.
     *
     * This slice used to carry only `status`, on the reasoning that
     * applyAutoReroute takes the itineraries as arguments and no screen renders
     * them. That reasoning outlived its truth: since eb74a9d8 deleted the
     * Switch/Keep card, an AMBIGUOUS missed bus — which must never auto-apply —
     * had nowhere to put its result, and on 2026-09-03 two real itineraries
     * were computed and silently discarded while the rider stood at the stop.
     * The position tick reads them from here to hand them to the planner and to
     * put the wait, in minutes, in the one push it sends.
     */
    candidates: Itinerary[]
    // Auto-apply may only pick itineraries boarding this route — the one the
    // rider already chose. Null = no constraint (manual re-routes).
    keepRouteId: string | null
    // What prompted the re-route (e.g. 'missed-bus'); diagnostic only.
    reason: string | null
    searchId: string | null
    // Wall-clock start of the in-flight search — lets the position tick
    // declare a 'searching' that never settled (WebView suspension) stuck.
    startedAtMs: number | null
    status: 'idle' | 'searching' | 'found' | 'none' | 'error'
  }

  /**
   * What the countdown at the destination has already told the rider, so the
   * two "leave for the return" alerts fire on a stage TRANSITION and not on
   * every 30 s post-arrival tick. Null until the first post-arrival tick of a
   * round trip; null forever on a one-way trip. See util/go-mode/round-trip.
   */
  returnCountdown: ReturnCountdownState | null

  /**
   * The durable "rider is aboard this vehicle" fact (see RidingState in
   * actions/go-mode). Survives new searches and itinerary switches; cleared
   * on alight, STOP_GO_MODE, or sustained off-route.
   */
  riding: RidingState | null

  /**
   * The return half of a ROUND TRIP, carried by the outbound trip: where the
   * rider is going back to, when they have to leave, and the return itinerary
   * itself. Null for an ordinary one-way trip, which is every trip that does
   * not come from the round-trip form.
   *
   * It is the presence of this that turns the arrival card into a countdown,
   * keeps the persisted session resumable for the hours of a real dwell, and
   * lets the post-arrival tick do the one job it still has. See
   * util/go-mode/round-trip.ts for the contract it shares with the planner.
   */
  roundTrip: RoundTripPlan | null

  routeMatch: RouteMatchResult | null

  simulation: SimulationState

  tracking: {
    error: GeolocationPositionError | null
    interval: number
    isTracking: boolean
    lastPosition: GeolocationPosition | null
    /**
     * The latest Go Mode fix whose accuracy was within `FIX_ACCURACY_MAX_M`
     * (51.3). `lastPosition` is the latest fix of any quality; an automatic
     * re-plan takes its origin from the freshest trusted fix instead — see
     * `pickReplanOriginFix` (util/go-mode/replan-origin).
     */
    lastTrustedPosition: GeolocationPosition | null
  }

  /**
   * The rider's turn-by-turn switch: a global default they set on the Settings
   * screen, plus per-leg opt-ins they set from the trip sheet mid-trip. See
   * util/go-mode/turn-cue-settings — the only consumer is checkUpcomingTurn.
   */
  turnCues: TurnCueSettings

  ui: {
    /**
     * Index of the leg the rider tapped in the trip sheet, or null for none.
     * The Go Mode equivalent of the planner's activeSearch.activeLeg: the map
     * zooms to it and draws it as selected.
     */
    activeLeg: number | null
    /**
     * The trip is running but the rider has stepped out to the normal trip
     * planner (browsing alternate routes). Tracking, notifications, and
     * auto-updates all keep running; only what's on screen changes. The
     * ReturnToTripBanner is the way back.
     */
    backgrounded: boolean
    mapFollowUser: boolean
  }

  vehicleMatch: {
    /**
     * How many DISTINCT feed frames (changes of the matched record's
     * `seconds`) the current run of `consecutiveMatches` rests on. The run is
     * counted per 1 s tick, the feed moves every 15-20 s; the riding rebind
     * gate needs both (35.1, RIDING_REBIND_MIN_FRAMES).
     */
    consecutiveFrames: number
    consecutiveMatches: number
    /**
     * Consecutive vehicle-position polls that came back with ZERO vehicles on
     * the tracked route. Some agencies publish no GTFS-RT vehicle feed at all
     * (or theirs is down), in which case a match can never happen and an
     * endless "Locating your bus…" reads as a hung app. Past
     * NO_LIVE_VEHICLE_POLLS the UI says so instead.
     */
    emptyPolls: number
    match: VehicleMatchResult | null
    nearbyVehicles: NearbyVehicleOption[]
    trackedRouteId: string | null
  }
}

const defaultState: GoModeState = {
  activeItinerary: null,

  alightedFrom: null,

  arm: null,

  arrivedAt: null,

  arrivedDelay: null,

  auto: AUTO_OFF,

  boardingPrompt: {
    chooseBus: false,
    chooseBusError: null,
    lastDismissedAt: null,
    searchFailed: false,
    searching: false,
    shown: false,
    transitLegEnteredAt: null
  },

  departureOverride: null,

  departureOverrideSource: null,

  departureOverrideTripId: null,

  earlyAlight: null,

  fasterRoute: null,

  isActive: false,
  liveLegTimes: {},
  multiStop: null,

  nearDestination: null,

  notifications: {
    enabled: true,
    recentNotifications: [],
    sentNotifications: [],
    soundEnabled: false,
    vibrationEnabled: true
  },

  onboard: {
    alightOptions: [],
    answeredCandidates: null,
    bestAlightStop: null,
    candidates: [],
    confirmingAtMs: null,
    failedCandidates: null,
    keepRouteId: null,
    passedStops: null,
    pendingCandidates: null,
    preview: null,
    resultAtMs: null,
    status: 'idle',
    stopChoiceFor: null,
    stops: null,
    totalCandidates: null,
    trip: null,
    vehicle: null
  },

  originalFrom: null,

  planStopOffer: null,

  progress: null,

  reRoute: {
    autoApply: false,
    candidates: [],
    keepRouteId: null,
    reason: null,
    searchId: null,
    startedAtMs: null,
    status: 'idle'
  },

  returnCountdown: null,

  riding: null,

  roundTrip: null,

  routeMatch: null,

  simulation: {
    pointIndex: 0,
    speedMultiplier: 1,
    status: 'idle',
    totalPoints: 0
  },

  tracking: {
    error: null,
    interval: 8000,
    isTracking: false,
    lastPosition: null,
    lastTrustedPosition: null
  },

  turnCues: { ...DEFAULT_TURN_CUE_SETTINGS },

  ui: {
    activeLeg: null,
    backgrounded: false,
    // On by default: each new trip opens in Google Maps-style live follow
    // (7/29 rider request — "it should follow dot as you are moving"). A drag,
    // rotate, or trip-sheet leg tap disengages it; the map's follow button
    // re-engages. STOP_GO_MODE resets to this default, so every trip starts
    // following, while START_GO_MODE preserves ui — a quiet background replan
    // must not override an explicit disengage mid-trip.
    mapFollowUser: true
  },

  vehicleMatch: {
    consecutiveFrames: 0,
    consecutiveMatches: 0,
    emptyPolls: 0,
    match: null,
    nearbyVehicles: [],
    trackedRouteId: null
  }
}

/** Route id from a leg — OTP2 object form (leg.route.id) or legacy leg.routeId. */
function legRouteId(leg: any): string | null {
  if (!leg) return null
  const route = leg.route
  if (route && typeof route === 'object') return route.id ?? null
  return leg.routeId ?? null
}

/**
 * Re-anchor the sticky riding fact onto a (possibly new) itinerary: find the
 * transit leg matching the boarded trip (preferred) or route. When the new
 * itinerary doesn't contain it, keep the fact un-anchored (legIndex -1) —
 * the rider is still on that bus until GPS disproves it.
 */
function reanchorRiding(
  riding: RidingState | null,
  itinerary: Itinerary | null,
  options: { routeFallback?: boolean } = {}
): RidingState | null {
  if (!riding || !itinerary?.legs) return riding
  const legs: any[] = itinerary.legs
  let legIndex = -1
  if (riding.tripId) {
    legIndex = legs.findIndex(
      (l) =>
        l?.transitLeg &&
        (l.trip?.gtfsId === riding.tripId || l.tripId === riding.tripId)
    )
  }
  // The route-only fallback is for a fact that never named its trip. On a
  // RESTART it must not stand in for a trip miss (54.1): on 2026-10-15 at
  // 21:21:07 it anchored the 18:14 Blue Line fact (trip 1:892049) onto the new
  // plan's tram leg (trip 1:983182) — same route, another train — and the
  // vehicle match it carried forced TRANSITION_LEG 1 five seconds later.
  const routeFallback = options.routeFallback ?? true
  if (legIndex < 0 && riding.routeId && (routeFallback || !riding.tripId)) {
    legIndex = legs.findIndex(
      (l) => l?.transitLeg && legRouteId(l) === riding.routeId
    )
  }
  return { ...riding, legIndex }
}

const goMode = handleActions<GoModeState, any>(
  {
    [ADD_NOTIFICATION]: (state, action) => {
      const notification: NotificationEvent = action.payload

      // Add to sent notifications to prevent duplicates
      const sentNotifications = [
        ...state.notifications.sentNotifications,
        notification.id
      ]

      // Evict by AGE first, then by count.
      //
      // A blind shift() at 50 evicts the OLDEST id regardless of whether its
      // dedup window is still open, so a chatty type (route deviation fires
      // every 120s; turn cues far more often) could push a one-shot id like
      // TRIP_COMPLETE or an alight alert out from under its own suppression
      // and let it fire a second time. The old comment knew the window "must
      // be wide enough" — but width alone cannot fix an eviction policy that
      // disagrees with the dedup policy.
      //
      // Every id already ends in its own stamp (generateNotificationId), and
      // wasRecentlySent parses it back out, so age is readable here without
      // any change of shape. Drop only ids older than the longest dedup window
      // in the service (ALIGHT_DEDUP_MS, 30 min), which is exactly the point
      // past which no caller can still be suppressing on them. On the clock
      // the ids are stamped with (75.29).
      const evictBefore = goModeClockMs() - 30 * 60 * 1000
      let kept = sentNotifications.filter((id) => {
        const stamp = parseInt(id.slice(id.lastIndexOf('_') + 1), 10)
        return Number.isNaN(stamp) || stamp >= evictBefore
      })
      // Backstop against unbounded growth if something ever fires in a tight
      // loop inside the window. 200 is well clear of a real ride's traffic.
      if (kept.length > 200) kept = kept.slice(kept.length - 200)

      // Add to recent notifications (keep last 10)
      const recentNotifications = [
        notification,
        ...state.notifications.recentNotifications
      ].slice(0, 10)

      return {
        ...state,
        notifications: {
          ...state.notifications,
          recentNotifications,
          sentNotifications: kept
        }
      }
    },

    // The rider's answer (63.1): "Still go to …" marks the stops kept —
    // never asked again this flow; "Skip" takes them out of this trip's stops
    // only (the search keeps them). From the flow, what follows is the list's
    // own search, so the status says so straight away.
    [ANSWER_ONBOARD_STOP_CHOICE]: (state, action) => {
      const passed = state.onboard.passedStops
      if (!passed?.length) return state
      const keep = !!action.payload?.keep
      const isPassed = (s: OnboardStop) =>
        passed.some((p) => sameOnboardStop(p, s))
      const stops = (state.onboard.stops || []).flatMap((s) =>
        !isPassed(s) ? [s] : keep ? [{ ...s, kept: true }] : []
      )
      return {
        ...state,
        onboard: {
          ...state.onboard,
          passedStops: null,
          status:
            state.onboard.stopChoiceFor === 'list'
              ? ('optimizing' as const)
              : state.onboard.status,
          stopChoiceFor: null,
          stops
        }
      }
    },

    // "Start when I leave" (65.2 B4): the rider has left and the start is
    // being made. Also the record.
    [AUTO_ARM_TRIGGER]: (state, action) =>
      state.arm && action.payload?.id === state.arm.id
        ? { ...state, arm: { ...state.arm, status: 'starting' } }
        : state,

    // Auto (65.2 B2). AUTO_SWITCH is also the record: `held` changes nothing.
    [AUTO_SWITCH]: (state, action) => {
      const p = action.payload || {}
      // A route set left (switched) or refused (undone) — never one the trip
      // is still on (an aboard stop move keeps the onward route).
      const add = (set: string | null | undefined) =>
        set == null ||
        p.fromRouteSet === p.toRouteSet ||
        state.auto.leftRouteSets.includes(set)
          ? state.auto.leftRouteSets
          : [...state.auto.leftRouteSets, set]
      if (p.outcome === 'switched') {
        return {
          ...state,
          auto: {
            ...state.auto,
            leftRouteSets: add(p.fromRouteSet),
            switches: state.auto.switches + 1
          }
        }
      }
      if (p.outcome === 'undone') {
        return {
          ...state,
          auto: {
            ...state.auto,
            leftRouteSets: add(p.toRouteSet),
            undo: null
          }
        }
      }
      return state
    },

    [BEGIN_ONBOARD_FLOW]: (state, action) => ({
      ...state,
      activeItinerary: null,
      // A trip is starting the rider's own way: the armed one is off (B4).
      arm: null,
      // "I'm already on the bus" from the planner starts a trip (65.2 Q2 = A).
      auto: AUTO_OFF,
      boardingPrompt: { ...defaultState.boardingPrompt },
      isActive: true,
      onboard: {
        ...defaultState.onboard,
        keepRouteId: action.payload?.keepRouteId ?? null,
        status: 'discovering' as const,
        // The search's added stops (63.1) — read by beginOnboardFlow before
        // this, off the query the rider searched with.
        stops: action.payload?.stops ?? []
      },
      originalFrom: action.payload?.originalFrom ?? null,
      progress: null,
      reRoute: { ...defaultState.reRoute },
      routeMatch: null,
      tracking: {
        ...state.tracking,
        error: null,
        isTracking: true
      },
      // Keep a confirmed vehicle: re-entering the onboard flow must not make
      // the app forget which bus it already verified the rider is on.
      vehicleMatch:
        state.vehicleMatch.match?.confidence === 'confirmed'
          ? state.vehicleMatch
          : { ...defaultState.vehicleMatch }
    }),

    // The arm goes: its start, a cancel, its lapse, or a trip started some
    // other way. Only the arm it names, when it names one.
    [CLEAR_AUTO_ARM]: (state, action) =>
      !state.arm ||
      (action.payload?.id != null && action.payload.id !== state.arm.id)
        ? state
        : { ...state, arm: null },

    [CLEAR_FASTER_ROUTE_OFFER]: (state, action) =>
      // Only the offer it names, when it names one: a clear for an offer that
      // has already been replaced must not take the new one with it.
      action.payload?.offerId &&
      state.fasterRoute?.offerId !== action.payload.offerId
        ? state
        : { ...state, fasterRoute: null },

    [CLEAR_ONBOARD]: (state) => ({
      ...state,
      onboard: { ...defaultState.onboard }
    }),

    [CLEAR_REROUTE]: (state) => ({
      ...state,
      reRoute: { ...defaultState.reRoute }
    }),

    [CLEAR_RIDING]: (state) => ({
      ...state,
      riding: null
    }),

    [CLEAR_VEHICLE_MATCH]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        chooseBus: false,
        chooseBusError: null,
        searching: false,
        shown: false,
        transitLegEnteredAt: null
      },
      vehicleMatch: {
        ...defaultState.vehicleMatch
      }
    }),

    // "Back to options". Clears the preview and NOTHING else: the list, the
    // trip, the vehicle and the candidate answers all stand, so returning
    // costs no re-plan and no refetch (17.1 — recovering the list used to cost
    // five OTP plan requests).
    [CLOSE_ONBOARD_PREVIEW]: (state) => ({
      ...state,
      onboard: {
        ...state.onboard,
        // Back drops a Confirm still re-checking (64.1): its answer is for a
        // preview the rider has left.
        confirmingAtMs: null,
        // ...and the added-stop card that Confirm put up (63.1), for the same
        // reason. The stop stays undecided; the next Confirm asks again.
        ...(state.onboard.stopChoiceFor === 'confirm'
          ? { passedStops: null, stopChoiceFor: null }
          : null),
        preview: null
      }
    }),

    [CONFIRM_VEHICLE]: (state, action) => ({
      ...state,
      // Confirming a vehicle is the rider (or a trusted match) asserting they
      // are aboard again — that outranks whatever they last got off.
      alightedFrom: null,
      boardingPrompt: {
        ...state.boardingPrompt,
        chooseBus: false,
        chooseBusError: null,
        searching: false,
        shown: false
      },
      earlyAlight: null,
      vehicleMatch: {
        ...state.vehicleMatch,
        consecutiveFrames: 0,
        consecutiveMatches: 0,
        match: action.payload
      }
    }),

    [DISMISS_BOARDING_PROMPT]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        chooseBus: false,
        chooseBusError: null,
        // Go Mode's clock, which shouldShowBoardingPrompt ages it on (75.29):
        // on the wall clock a dismissal in a replay lay weeks in the sim's
        // future, and the prompt stayed suppressed for the rest of it.
        lastDismissedAt: goModeClockMs(),
        searching: false,
        shown: false
      }
    }),

    /**
     * A tap on an option — the row, or one of its same-shape variants — opens
     * the preview for it. The payload names the option rather than carrying
     * it, so the debug-stream entry for the tap stays small (17.11); the
     * option is resolved out of the live list here.
     *
     * Resolution is by index with the stop id as the check, falling back to
     * the stop id alone: a straggler can have re-ranked the list between
     * render and tap, in which case the index is stale but the identity is
     * not. An option that is no longer in the list at all leaves state alone
     * (the tap is stale) rather than previewing something the rider did not
     * choose.
     */
    // "On a different bus?" (51.1): the sheet opens already searching, so the
    // empty list is never read as an answer before a poll has been compared.
    [OPEN_CHOOSE_BUS]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        chooseBus: true,
        chooseBusError: null,
        searchFailed: false,
        searching: true,
        shown: true
      }
    }),

    [OPEN_ONBOARD_PREVIEW]: (state, action) => {
      const list = state.onboard.alightOptions || []
      const { control, index, stopId } = action.payload || {}
      const atIndex = typeof index === 'number' ? list[index] : undefined
      const option =
        atIndex && (!stopId || atIndex.stopId === stopId)
          ? atIndex
          : list.find((o: OnboardAlightOption) => o.stopId === stopId)
      if (!option) return state
      return {
        ...state,
        onboard: {
          ...state.onboard,
          preview: {
            control:
              control === 'variant' ? ('variant' as const) : ('row' as const),
            openedAtMs: action.payload?.tMs ?? Date.now(),
            option
          }
        }
      }
    },

    [PAUSE_GPS_SIMULATION]: (state) => ({
      ...state,
      simulation: {
        ...state.simulation,
        status: 'paused' as const
      }
    }),

    // Swap in a leg's repaired polyline (see repairLegGeometry). Only the
    // legGeometry field changes; the leg object is necessarily new, which
    // resets any WeakMap state keyed on it in notification-service — that
    // state is walk/bike turn tracking and connection baselines, neither of
    // which a transit leg that was unmatchable until now can have accrued.
    [REPAIR_LEG_GEOMETRY]: (state: GoModeState, action: any) => {
      const { legGeometry, legIndex } = action.payload
      const itinerary: any = state.activeItinerary
      const leg = itinerary?.legs?.[legIndex]
      if (!leg) return state
      const legs = itinerary.legs.slice()
      legs[legIndex] = { ...leg, legGeometry }
      return {
        ...state,
        activeItinerary: { ...itinerary, legs }
      }
    },

    [RESUME_GPS_SIMULATION]: (state) => ({
      ...state,
      simulation: {
        ...state.simulation,
        status: 'running' as const
      }
    }),

    [SET_ARRIVED]: (state, action) => ({
      ...state,
      arrivedAt: action.payload,

      // The arrival tick dispatches UPDATE_PROGRESS before it dispatches this,
      // so `state.progress.delay` here IS the measurement taken at arrival.
      arrivedDelay: state.progress?.delay ?? null,

      // The dwell has done its job, or the distance did it first (12.17).
      nearDestination: null
    }),

    // "Start when I leave" (65.2 B4). SET_AUTO_ARM installs an arm ({ arm })
    // or patches the one installed ({ id, point } / { id, preset }) — never
    // another arm's.
    [SET_AUTO_ARM]: (state, action) => {
      const p = action.payload || {}
      if (p.arm) return { ...state, arm: p.arm }
      if (!state.arm || p.id !== state.arm.id) return state
      const patch: Partial<AutoArm> = {}
      if (p.point !== undefined) patch.point = p.point
      if (p.preset) patch.preset = p.preset
      return { ...state, arm: { ...state.arm, ...patch } }
    },

    [SET_AUTO_MODE]: (state, action) => ({
      ...state,
      auto: {
        ...state.auto,
        on: !!action.payload?.on,
        preset: action.payload?.preset ?? state.auto.preset,
        // Turning Auto off takes its Undo with it; the counts stay for the
        // trip (the cap and the left routes are per trip, not per toggle).
        undo: action.payload?.on ? state.auto.undo : null
      }
    }),

    // The Undo on the card: set after a switch, cleared when it lapses — only
    // the one it names, so a lapse cannot take a newer switch's Undo.
    [SET_AUTO_UNDO]: (state, action) => {
      const undo = action.payload?.undo ?? null
      if (
        !undo &&
        action.payload?.switchId &&
        state.auto.undo?.switchId !== action.payload.switchId
      ) {
        return state
      }
      return { ...state, auto: { ...state.auto, undo } }
    },

    [SET_BOARDING_SEARCH_FAILED]: (state, action) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        searchFailed: !!action.payload
      }
    }),

    [SET_BOARDING_SEARCHING]: (state, action) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        searching: !!action.payload
      }
    }),

    // The payload is either a bare epoch (or null), which is the auto-anchor's
    // own voice and the shape every caller used before 12.15, or
    // `{ ms, source }` when the writer knows whose pick it is. Normalized here
    // rather than at the call sites so the two fields can never disagree.
    [SET_CHOOSE_BUS_ERROR]: (state, action: any) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        chooseBusError: action.payload ?? null,
        searching: false
      }
    }),

    [SET_DEPARTURE_OVERRIDE]: (state, action) => {
      const { payload } = action
      const ms =
        payload != null && typeof payload === 'object' ? payload.ms : payload
      const source =
        payload != null && typeof payload === 'object'
          ? payload.source ?? 'anchor'
          : 'anchor'
      const tripId =
        payload != null && typeof payload === 'object'
          ? payload.tripId ?? null
          : null
      return {
        ...state,
        departureOverride: ms ?? null,
        departureOverrideSource: ms == null ? null : source,
        departureOverrideTripId: ms == null ? null : tripId
      }
    },

    [SET_EARLY_ALIGHT]: (state, action) => ({
      ...state,
      // An early alight IS an alight: record which trip they got off, the same
      // way TRANSITION_LEG does, so beginOnboardFlow cannot read a surviving
      // confirmed vehicleMatch as proof they are still aboard (the 8/9 hole).
      alightedFrom: action.payload
        ? {
            tripId: action.payload.tripId ?? null,
            vehicleId: action.payload.vehicleId ?? null
          }
        : state.alightedFrom,
      // The plan's own departure pick belonged to the bus they just left.
      departureOverride: null,
      departureOverrideSource: null,
      departureOverrideTripId: null,
      earlyAlight: action.payload,
      riding: null
    }),

    [SET_FASTER_ROUTE_OFFER]: (state, action) => ({
      ...state,
      fasterRoute: action.payload ?? null
    }),

    [SET_GO_MODE_ACTIVE_LEG]: (state, action) => ({
      ...state,
      ui: {
        ...state.ui,
        activeLeg: action.payload ?? null
      }
    }),

    [SET_GO_MODE_BACKGROUNDED]: (state, action) => ({
      ...state,
      ui: {
        ...state.ui,
        backgrounded: !!action.payload
      }
    }),

    [SET_LEG_TURN_CUES]: (state, action) => ({
      ...state,
      turnCues: {
        ...state.turnCues,
        legOverrides: {
          ...state.turnCues.legOverrides,
          [action.payload.legIndex]: !!action.payload.enabled
        }
      }
    }),

    [SET_LIVE_LEG_TIMES]: (state, action) => ({
      ...state,
      liveLegTimes: action.payload
    }),

    [SET_MAP_FOLLOW]: (state: GoModeState, action: any) => ({
      ...state,
      ui: {
        ...state.ui,
        mapFollowUser: !!action.payload
      }
    }),

    [SET_NEAR_DESTINATION]: (state, action) => ({
      ...state,
      nearDestination: action.payload ?? null
    }),

    [SET_NOTIFICATION_CONFIG]: (state, action) => {
      return {
        ...state,
        notifications: {
          ...state.notifications,
          ...action.payload
        }
      }
    },

    [SET_ONBOARD_CONFIRMING]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        confirmingAtMs: action.payload ?? null
      }
    }),

    [SET_ONBOARD_RESULT]: (state, action) => {
      // Two payload shapes on purpose. A bare array is the original one and
      // still means "this is the whole answer"; the object form carries how
      // many candidates answered, so the UI can say the answer is partial.
      const payload = action.payload
      const isCounted = !!payload && !Array.isArray(payload)
      const options: OnboardAlightOption[] = isCounted
        ? payload.options || []
        : payload || []
      return {
        ...state,
        onboard: {
          ...state.onboard,
          alightOptions: options,
          answeredCandidates: isCounted
            ? payload.answeredCandidates ?? null
            : state.onboard.candidates.length || null,
          bestAlightStop: options[0] || null,
          // A bare array still means "this is the whole answer", so it has no
          // failures by definition.
          failedCandidates: isCounted ? payload.failedCandidates ?? 0 : 0,
          pendingCandidates: isCounted ? payload.pendingCandidates ?? 0 : 0,
          resultAtMs: isCounted ? payload.resultAtMs ?? null : null,
          status: options.length ? ('ready' as const) : ('error' as const),
          totalCandidates: isCounted
            ? payload.totalCandidates ??
              (state.onboard.candidates.length || null)
            : state.onboard.candidates.length || null
        }
      }
    },

    [SET_ONBOARD_STATUS]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        status: action.payload
      }
    }),

    // The added-stop card goes up (63.1). From the flow ('list') it is the
    // whole screen until answered; from the Confirm it stands over the
    // preview, which is kept.
    [SET_ONBOARD_STOP_CHOICE]: (state, action) => {
      const passed: OnboardStop[] = action.payload?.passedStops || []
      if (!passed.length) return state
      const stopChoiceFor = action.payload?.stopChoiceFor ?? 'list'
      return {
        ...state,
        onboard: {
          ...state.onboard,
          passedStops: passed,
          status:
            stopChoiceFor === 'list'
              ? ('added-stop-choice' as const)
              : state.onboard.status,
          stopChoiceFor
        }
      }
    },

    [SET_ONBOARD_TRIP]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        trip: action.payload
      }
    }),

    [SET_ONBOARD_VEHICLE]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        // Adopting a vehicle IS the start of its schedule fetch. DROPPING one
        // is not: a denial reopening the picker clears the vehicle the rider
        // just rejected (so the sheet's fallback row cannot hand it back —
        // 15.3, 17.5) and owns the status itself.
        status: action.payload
          ? ('fetching-schedule' as const)
          : state.onboard.status,
        vehicle: action.payload
      }
    }),

    [SET_PLAN_STOP_OFFER]: (state, action) => ({
      ...state,
      planStopOffer: action.payload ?? null
    }),

    [SET_REROUTE_RESULT]: (state, action) => {
      // Payload is the full list of alternatives (or null/[] for "none"), or a
      // single itinerary — the original one-result shape, still used by tests
      // and by callers that have exactly one answer.
      const payload = action.payload
      const candidates: Itinerary[] = Array.isArray(payload)
        ? payload
        : payload
        ? [payload]
        : []
      return {
        ...state,
        reRoute: {
          ...state.reRoute,
          // Results resolved (or "none") — the auto-apply moment, if there
          // was one, has passed.
          autoApply: false,
          candidates,
          status: candidates.length ? ('found' as const) : ('none' as const)
        }
      }
    },

    [SET_RETURN_COUNTDOWN]: (state, action) => ({
      ...state,
      returnCountdown: action.payload ?? null
    }),

    [SET_RIDING]: (state, action) => ({
      ...state,
      alightedFrom: action.payload ? null : state.alightedFrom,
      // Aboard again outranks "got off early" — and it is the only thing
      // besides a leg transition that may retire the re-anchoring.
      earlyAlight: action.payload ? null : state.earlyAlight,
      riding: action.payload
    }),

    [SET_ROUND_TRIP]: (state, action) => ({
      ...state,
      // The countdown state is NOT cleared here. A refresh that keeps the same
      // departure must not re-fire "leave in 10 min", and one that moves it
      // re-arms on its own: evaluateReturnCountdown compares the stored
      // leaveByMs with the plan's and treats a change as a re-arm.
      roundTrip: action.payload ?? null
    }),

    [SET_TRACKING_ERROR]: (state, action) => {
      return {
        ...state,
        tracking: {
          ...state.tracking,
          error: action.payload
        }
      }
    },

    [SET_TRANSIT_LEG_ENTERED]: (state, action) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        transitLegEnteredAt: action.payload
      }
    }),

    [SET_TURN_CUE_DEFAULT]: (state, action) => ({
      ...state,
      turnCues: {
        ...state.turnCues,
        enabledByDefault: !!action.payload
      }
    }),

    [SHOW_BOARDING_PROMPT]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        // The boarding flow's own sheet is never the choose-bus one (51.1).
        chooseBus: false,
        chooseBusError: null,
        shown: true
      }
    }),

    [START_GO_MODE]: (state, action) => {
      const { itinerary, multiStop, newTrip, originalFrom, roundTrip } =
        action.payload
      const nowMs: number = action.payload?.nowMs ?? Date.now()
      const restart = !state.isActive
      const carried =
        !restart ||
        (ridingFactIsEvidenced(state.riding) &&
          !ridingKeptTooLong(state.riding, nowMs))
          ? state.riding
          : null
      const restartedRiding = reanchorRiding(
        carried ? { ...carried, keptAtMs: null } : null,
        itinerary,
        { routeFallback: !restart }
      )

      // `ui` is deliberately preserved: a background auto-update (missed bus,
      // quiet access replan) swaps the itinerary via this action while the
      // rider may be browsing the planner — that must not clear
      // ui.backgrounded and yank them back to the Go Mode screen.
      return {
        ...state,
        activeItinerary: itinerary,
        // Any trip that starts ends an arm (65.2 B4): its own start cleared
        // it already; a Start Trip tapped while armed replaces it.
        arm: null,
        arrivedAt: null,
        arrivedDelay: null,

        // Auto is per trip (65.2 Q2 = A): off when a trip STARTS — Go Mode
        // was off, or the rider tapped Start Trip on another route — and kept
        // across a swap within the trip, its own switch included. The Undo is
        // about the plan just replaced, so it goes.
        auto:
          restart || newTrip
            ? AUTO_OFF
            : state.auto.undo
            ? { ...state.auto, undo: null }
            : state.auto,

        // The departure pick belonged to the plan that has just been replaced
        // (12.14). A mid-trip auto-update IS a START_GO_MODE, so an override
        // chosen against the pre-swap itinerary used to survive onto one that
        // may board a different run entirely — the card would headline a bus
        // the new plan does not contain. `TRANSITION_LEG` and
        // `SET_EARLY_ALIGHT` have always nulled it for the same reason; this
        // path never did.
        //
        // Clearing is the whole fix, and it does not fight the anchor's own
        // re-target: with the override gone, `evaluateDepartureAnchor` falls
        // back to the new plan's `plannedBoardMs` and re-acquires the soonest
        // catchable departure on the route the rider chose, which is the
        // rider's standing rule. The session flags that would otherwise keep a
        // dead boarding's lock alive are reset alongside it, in beginGoMode.
        departureOverride: null,

        departureOverrideSource: null,

        departureOverrideTripId: null,

        // Compared with the plan that has just been replaced (56.1).
        fasterRoute: null,

        isActive: true,

        liveLegTimes: {},

        // Same rule as roundTrip below: beginGoMode passes the plan back in
        // for a swap within the same segment; absent clears it.
        multiStop: multiStop ?? null,

        // ...and kept across a swap, which a quiet re-plan at the door is: the
        // minute belongs to a destination, not to a plan, and the tick and the
        // timer both re-check it against the new plan's own `to` (12.17). A
        // fresh start begins with none.
        nearDestination: restart ? null : state.nearDestination ?? null,
        notifications: {
          ...state.notifications,
          recentNotifications: [],
          // Alight and board-vehicle alerts are keyed to a physical stop (and,
          // for boarding, the trip), and they alone survive a trip swap: a
          // background auto-update re-enters here with a new itinerary, and
          // wiping their history let the same stop buzz the rider a second
          // time — the complaint this whole path exists to fix. A re-plan onto
          // a DIFFERENT run still re-arms the board alerts, because the trip
          // id is part of their key. Everything else (boarding prompts,
          // connections, turns) is about the trip that just changed and must
          // be free to fire again.
          sentNotifications: state.notifications.sentNotifications.filter(
            (id) =>
              id.startsWith('APPROACH_STOP_') ||
              id.startsWith('ARRIVING_STOP_') ||
              id.startsWith('BOARD_BUS_APPROACHING_') ||
              id.startsWith('BOARD_BUS_ARRIVING_') ||
              // "Time to go" is keyed on route + boarding stop, and a
              // same-connection swap changes neither: the rider leaves for the
              // same stop to catch the same route. On 2026-09-09 the ride's two
              // itinerary swaps re-fired it at 08:17:34, 08:21:49 and 08:22:31
              // — three "Time to go" pushes in 4m57s, each in the same second
              // as a START_GO_MODE (daemon page `notification-repeat`). A
              // re-plan onto a different route or a different boarding stop
              // carries a different context and still re-arms.
              id.startsWith('LEAVE_SOON_') ||
              // "Missed bus" survives its OWN recovery. The missed-bus replan
              // dispatches START_GO_MODE, which used to wipe the id that had
              // just been sent — and on 2026-09-21 the replan landed on the
              // very same trip (1:1273254) at the very same stop (1:17781)
              // with the same board epoch, so the next tick raised an
              // identical claim and pushed it again 21 s later (17:05:45 and
              // 17:06:06, both with an auto-applied re-plan behind them;
              // daemon page `notification-repeat`). The id carries the route,
              // the boarding stop and the effective departure, so a recovery
              // onto a genuinely different departure has a different id and
              // still re-arms — the same self-limiting rule as LEAVE_SOON_.
              id.startsWith('MISSED_BUS_')
          )
        },
        originalFrom: originalFrom ?? null,
        planStopOffer: null,
        progress: null,

        reRoute: { ...defaultState.reRoute },

        // The countdown belongs to the plan, and the plan has just been
        // (re)stated: a mid-trip itinerary swap on a round trip re-enters here
        // with the SAME roundTrip, and re-arming from null is correct — the
        // rider has not arrived yet, so there is no stage to preserve, and
        // evaluateReturnCountdown's first-evaluation rule stops it buzzing for
        // a window it is already inside.
        returnCountdown: null,
        // A mid-ride itinerary SWAP (isActive already true) keeps the fact:
        // the rider is on the same bus, only the plan around them changed. A
        // RESTART is different — Go Mode was stopped and started again, and
        // the only reason a riding fact survives STOP_GO_MODE is so the "I'm
        // on the bus" flow does not re-ask which bus (7/12). Resuming a fact
        // that never named a bus resumes a guess: on 2026-09-01 the GPS-only
        // board of 10:47:15 rode STOP_GO_MODE 10:48:47 -> START_GO_MODE
        // 10:48:50 into the next trip, which therefore began already aboard,
        // and TRANSITION_LEG stepped straight onto the bus leg one second
        // later. An unevidenced fact has to be re-earned; an evidenced one
        // (a real, non-synthetic vehicle id) is a physical fact and stays.
        //
        // ...and an evidenced fact is only physical while it is CURRENT
        // (54.1): a fact kept across STOP_GO_MODE for longer than the 7/12
        // back-out-and-reopen needs is dropped here. The feed and trip-end
        // checks need the transit index and are applied by beginGoMode before
        // it dispatches this; the age check is here so no caller can skip it.
        // A fact resumed by a restart is in use again, so its keep stamp goes.
        riding: restartedRiding,
        // Absent means one-way, explicitly: an auto-update that swaps the
        // outbound itinerary mid-trip goes through beginGoMode with no
        // options, and a round trip must not silently survive a re-plan the
        // rider never tied a return to. beginGoMode passes the plan back in
        // when it is still the same trip; everything else clears it.
        roundTrip: roundTrip ?? null,
        routeMatch: null,
        tracking: {
          ...state.tracking,
          error: null,
          isTracking: true
        },
        // The global default is the rider's standing choice and survives; the
        // per-leg opt-ins do not. They are keyed by leg INDEX, and this action
        // is also how a mid-trip auto-update swaps the itinerary — leg 1 of the
        // new plan is not the leg the rider opted in on, so carrying the map
        // over would turn cues on for a leg they never chose (and off for one
        // they did).
        turnCues: {
          enabledByDefault: state.turnCues.enabledByDefault,
          legOverrides: {}
        },
        // The vehicle match belongs to the itinerary that just went away. It
        // was carried across untouched, so the first tick after a swap
        // refreshed a CONFIRMED match against the previous trip's cached
        // vehicles using the new rider position — which on 2026-08-27 reported
        // the rider 5,220 m from "their" bus for one frame, 51 ms before the
        // fresh feed arrived and the next tick read 698 m.
        //
        // Two comments elsewhere (actions/go-mode.ts, in beginGoMode and
        // replanFromAboard) already assert that beginGoMode resets this. It
        // did not. Now it does, so those comments are true and
        // reconfirmBoardedVehicle is undoing a reset that actually happens.
        //
        // A confirmed match is preserved when the rider is still riding: an
        // auto-update mid-ride (missed bus, quiet replan) hands back a new
        // itinerary for the SAME bus the rider is sitting on, and making them
        // re-confirm it would be a regression. reanchorRiding above decides
        // that, so key off its result rather than the pre-swap state.
        //
        // Keyed off the CARRIED fact: a dropped (stale or unevidenced) fact
        // must not leave its confirmed match behind to be re-asserted.
        vehicleMatch: restartedRiding
          ? state.vehicleMatch
          : { ...defaultState.vehicleMatch }
      }
    },

    [START_GPS_SIMULATION]: (state, action) => ({
      ...state,
      simulation: {
        pointIndex: 0,
        speedMultiplier: action.payload.speedMultiplier,
        status: 'running' as const,
        totalPoints: action.payload.totalPoints
      }
    }),

    [START_ONBOARD_OPTIMIZE]: (state, action) => ({
      ...state,
      onboard: {
        ...state.onboard,
        alightOptions: [],
        answeredCandidates: 0,
        bestAlightStop: null,
        candidates: action.payload.candidates,
        failedCandidates: 0,
        pendingCandidates: action.payload.candidates?.length ?? 0,
        // A fresh search invalidates a preview of the old list's option.
        preview: null,
        status: 'optimizing' as const,
        totalCandidates: action.payload.candidates?.length ?? 0
      }
    }),

    [START_REROUTE]: (state, action) => ({
      ...state,
      reRoute: {
        autoApply: !!action.payload.autoApply,
        // A new search invalidates the last one's answer immediately, not when
        // it resolves: the alternatives to a trip that has just changed under
        // the rider are not alternatives to anything.
        candidates: [],
        keepRouteId: action.payload.keepRouteId ?? null,
        reason: action.payload.reason ?? null,
        searchId: action.payload.searchId,
        startedAtMs: action.payload.startedAtMs ?? null,
        status: 'searching' as const
      }
    }),

    [STOP_GO_MODE]: (state, action) => ({
      ...defaultState,

      // Getting OFF a bus is just as physical, and it has to survive alongside
      // the confirmed match below — otherwise exiting Go Mode after an alight
      // hands the next onboard flow the match without the fact that disproves
      // it, which is the 8/9 hole through a different door.
      alightedFrom: state.alightedFrom,

      // Not the trip's to end (65.2 B4): an arm is made with Go Mode off.
      arm: state.arm,
      // Being aboard a bus is a physical fact; exiting the Go Mode screen
      // doesn't change it. On 7/12 the rider backed out and immediately
      // reopened "I'm on the bus" — with riding wiped here, the flow forgot
      // the confirmed vehicle and re-ran (failing) discovery. Alight and
      // sustained off-route remain the only physical invalidators.
      //
      // Stamped with WHEN (54.1): nothing re-evidences the fact while Go Mode
      // is off, so the next start / "I'm on the bus" asks how long it has been
      // kept (ridingFactIsCurrent). An earlier stamp stands — an onboard flow
      // that re-adopted the fact and was backed out of again has not made it
      // any fresher.
      riding: state.riding
        ? {
            ...state.riding,
            keptAtMs:
              state.riding.keptAtMs ??
              (typeof action.payload?.nowMs === 'number'
                ? action.payload.nowMs
                : Date.now())
          }
        : null,
      // The rider's global turn-by-turn choice is a SETTING, not trip state:
      // ending a trip must not silently return it to the shipped default. The
      // per-leg overrides go with the trip they belonged to (defaultState).
      turnCues: {
        enabledByDefault: state.turnCues.enabledByDefault,
        legOverrides: {}
      },
      vehicleMatch:
        state.vehicleMatch.match?.confidence === 'confirmed'
          ? state.vehicleMatch
          : { ...defaultState.vehicleMatch }
    }),

    [STOP_GPS_SIMULATION]: (state) => ({
      ...state,
      simulation: {
        pointIndex: 0,
        speedMultiplier: 1,
        status: 'idle' as const,
        totalPoints: 0
      }
    }),

    [TOGGLE_MAP_FOLLOW]: (state) => {
      return {
        ...state,
        ui: {
          ...state.ui,
          mapFollowUser: !state.ui.mapFollowUser
        }
      }
    },

    [TRANSITION_LEG]: (state, action) => {
      const { legIndex } = action.payload

      // Advancing past the boarded transit leg means the rider alighted —
      // drop the sticky riding fact.
      const alighted =
        state.riding != null &&
        state.riding.legIndex >= 0 &&
        legIndex > state.riding.legIndex

      return {
        ...state,
        // Remember WHICH trip they got off. A confirmed vehicleMatch can
        // outlive riding (STOP_GO_MODE and session restore keep one on
        // purpose), and beginOnboardFlow used to treat that as proof the rider
        // was aboard — 8/9, 90 s after this very transition.
        alightedFrom: alighted
          ? {
              tripId: state.riding?.tripId ?? null,
              vehicleId: state.riding?.vehicleId ?? null
            }
          : state.alightedFrom,
        departureOverride: null,
        departureOverrideSource: null,
        departureOverrideTripId: null,
        // The early-alight re-anchoring exists only while the matcher is still
        // stuck on the leg the rider stepped off; once the trip has actually
        // moved past it, the ordinary boarding path is back in charge.
        earlyAlight:
          state.earlyAlight != null && legIndex > state.earlyAlight.legIndex
            ? null
            : state.earlyAlight,
        riding: alighted ? null : state.riding,
        routeMatch: state.routeMatch
          ? {
              ...state.routeMatch,
              legIndex,
              // This match was never measured — it is a re-anchor onto a leg
              // the rider has not been projected onto yet, and its
              // nearestPoint still belongs to the OLD leg. The continuity gate
              // measures a cross-leg move as ground distance from that point,
              // so leaving the stamp would make the next tick's first honest
              // projection look like a several-hundred-metre teleport and hold
              // it for seconds. No stamp means no elapsed time, which means no
              // budget and no gating: the next real fix is taken as it comes.
              matchedAtMs: undefined,
              // The new leg starts at its start: inheriting the previous
              // leg's ~1.0 progress made the manual "I got off here"/onboard
              // paths flash "1 stop remaining" (and its GET READY banner)
              // until the next GPS tick recomputed honestly.
              progressAlongLeg: 0,
              progressAlongSegment: 0,
              segmentIndex: 0,
              // 12.17 (2026-10-29 replay R11): and the ground the OLD leg
              // still owed goes with it. It is owed along that leg's
              // polyline; carried over, it licensed jumps on this one. On
              // orange-0917-2053 an `unaccountedFromFix` set at 21:07:12 on leg
              // 0 survived two leg changes, and at 21:39:19 the rider's
              // 14,455 m displacement from it released 0.06 -> 0.985 on the
              // closing bike leg with the rider 528 m off it (ride-1015-2130
              // carried the tram leg's 2,302 m the same way). Cleared, the
              // matcher starts the owed ground afresh from the next fix, as
              // after START_GO_MODE.
              unaccountedFromFix: undefined,
              unaccountedPathM: undefined
            }
          : null
      }
    },

    [UPDATE_NEARBY_VEHICLES]: (state: GoModeState, action: any) => ({
      ...state,
      // A poll has been compared against the rider's position, so an empty
      // list is now a finding rather than a state the sheet has not reached.
      boardingPrompt: {
        ...state.boardingPrompt,
        searching: false
      },
      vehicleMatch: {
        ...state.vehicleMatch,
        nearbyVehicles: action.payload
      }
    }),

    [UPDATE_POSITION]: (state: GoModeState, action: any) => {
      const accuracy = action.payload?.coords?.accuracy
      const trusted =
        accuracy != null &&
        Number.isFinite(accuracy) &&
        accuracy <= FIX_ACCURACY_MAX_M
      return {
        ...state,
        tracking: {
          ...state.tracking,
          error: null,
          lastPosition: action.payload,
          lastTrustedPosition: trusted
            ? action.payload
            : state.tracking.lastTrustedPosition ?? null
        }
      }
    },

    [UPDATE_PROGRESS]: (state: GoModeState, action: any) => {
      return {
        ...state,
        progress: action.payload
      }
    },

    [UPDATE_ROUTE_MATCH]: (state: GoModeState, action: any) => {
      return {
        ...state,
        routeMatch: action.payload
      }
    },

    [UPDATE_SIMULATION_PROGRESS]: (state: GoModeState, action: any) => ({
      ...state,
      simulation: {
        ...state.simulation,
        pointIndex: action.payload.pointIndex
      }
    }),

    [UPDATE_TRACKING_INTERVAL]: (state: GoModeState, action: any) => {
      const { interval } = action.payload

      return {
        ...state,
        tracking: {
          ...state.tracking,
          interval
        }
      }
    },

    // Payload keys are optional so the "no vehicles on this route" poll can
    // bump emptyPolls alone without clobbering the last real match.
    [UPDATE_VEHICLE_MATCH]: (state: GoModeState, action: any) => ({
      ...state,
      vehicleMatch: {
        ...state.vehicleMatch,
        ...(action.payload.consecutiveMatches !== undefined && {
          consecutiveMatches: action.payload.consecutiveMatches
        }),
        ...(action.payload.consecutiveFrames !== undefined && {
          consecutiveFrames: action.payload.consecutiveFrames
        }),
        ...(action.payload.emptyPolls !== undefined && {
          emptyPolls: action.payload.emptyPolls
        }),
        ...(action.payload.match !== undefined && {
          match: action.payload.match
        })
      }
    })
  },
  defaultState
)

export default goMode
