import { handleActions } from 'redux-actions'
import type { Itinerary } from '@opentripplanner/types'

import {
  ADD_NOTIFICATION,
  BEGIN_ONBOARD_FLOW,
  CLEAR_ONBOARD,
  CLEAR_REROUTE,
  CLEAR_RIDING,
  CLEAR_VEHICLE_MATCH,
  CONFIRM_VEHICLE,
  DISMISS_BOARDING_PROMPT,
  PAUSE_GPS_SIMULATION,
  REPAIR_LEG_GEOMETRY,
  RESUME_GPS_SIMULATION,
  SET_ARRIVED,
  SET_DEPARTURE_OVERRIDE,
  SET_GO_MODE_ACTIVE_LEG,
  SET_GO_MODE_BACKGROUNDED,
  SET_LIVE_LEG_TIMES,
  SET_MAP_FOLLOW,
  SET_NOTIFICATION_CONFIG,
  SET_ONBOARD_RESULT,
  SET_ONBOARD_STATUS,
  SET_ONBOARD_TRIP,
  SET_ONBOARD_VEHICLE,
  SET_REROUTE_RESULT,
  SET_RIDING,
  SET_TRACKING_ERROR,
  SET_TRANSIT_LEG_ENTERED,
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
import { ridingFactIsEvidenced } from '../util/go-mode/riding'
import type { LiveLegTime, RidingState } from '../util/go-mode/types'
import type {
  NearbyVehicleOption,
  VehicleMatchResult
} from '../util/go-mode/vehicle-matching'
import type { NotificationEvent } from '../util/go-mode/notification-service'
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
  /** The route the rider already chose for the leg after this bus, captured
   * when the flow opened (BEGIN_ONBOARD_FLOW nulls activeItinerary, so it
   * cannot be re-derived later). Ranks its options up, never filters. */
  keepRouteId: string | null
  /**
   * Candidates whose onward plan was still in flight when the deadline fired,
   * so a straggler could still land and improve the list. Rejections are NOT
   * counted here — those are over. Null when unknown.
   */
  pendingCandidates: number | null
  status:
    | 'idle'
    | 'discovering'
    | 'awaiting-selection'
    | 'fetching-schedule'
    | 'optimizing'
    | 'ready'
    | 'error'
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

  /** Epoch ms when trip progress first read completed; null while en route.
   * While set, position ticks quiesce and the arrival card is shown. */
  arrivedAt: number | null

  boardingPrompt: {
    lastDismissedAt: number | null
    shown: boolean
    transitLegEnteredAt: number | null
  }

  departureOverride: number | null

  isActive: boolean

  /** Live (or schedule-fallback) transit-leg times, keyed by leg index. Kept
   * fresh mid-ride by refreshLiveLegTimes; consumed by the trip overview. */
  liveLegTimes: Record<number, LiveLegTime>

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

  progress: TripProgress | null

  reRoute: {
    // Apply the best result without asking (definitive missed bus). There is
    // no Switch/Keep card: applyAutoReroute takes the itineraries as
    // arguments, so this slice carries only the search's status, never its
    // results.
    autoApply: boolean
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
   * The durable "rider is aboard this vehicle" fact (see RidingState in
   * actions/go-mode). Survives new searches and itinerary switches; cleared
   * on alight, STOP_GO_MODE, or sustained off-route.
   */
  riding: RidingState | null

  routeMatch: RouteMatchResult | null

  simulation: SimulationState

  tracking: {
    error: GeolocationPositionError | null
    interval: number
    isTracking: boolean
    lastPosition: GeolocationPosition | null
  }

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

  arrivedAt: null,

  boardingPrompt: {
    lastDismissedAt: null,
    shown: false,
    transitLegEnteredAt: null
  },

  departureOverride: null,

  isActive: false,
  liveLegTimes: {},
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
    keepRouteId: null,
    pendingCandidates: null,
    status: 'idle',
    trip: null,
    vehicle: null
  },

  originalFrom: null,

  progress: null,

  reRoute: {
    autoApply: false,
    keepRouteId: null,
    reason: null,
    searchId: null,
    startedAtMs: null,
    status: 'idle'
  },

  riding: null,

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
    lastPosition: null
  },

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
  itinerary: Itinerary | null
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
  if (legIndex < 0 && riding.routeId) {
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
      // Every id already ends in its Date.now() (generateNotificationId), and
      // wasRecentlySent parses it back out, so age is readable here without
      // any change of shape. Drop only ids older than the longest dedup window
      // in the service (ALIGHT_DEDUP_MS, 30 min), which is exactly the point
      // past which no caller can still be suppressing on them.
      const evictBefore = Date.now() - 30 * 60 * 1000
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

    [BEGIN_ONBOARD_FLOW]: (state, action) => ({
      ...state,
      activeItinerary: null,
      boardingPrompt: { ...defaultState.boardingPrompt },
      isActive: true,
      onboard: {
        ...defaultState.onboard,
        keepRouteId: action.payload?.keepRouteId ?? null,
        status: 'discovering' as const
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
        shown: false,
        transitLegEnteredAt: null
      },
      vehicleMatch: {
        ...defaultState.vehicleMatch
      }
    }),

    [CONFIRM_VEHICLE]: (state, action) => ({
      ...state,
      // Confirming a vehicle is the rider (or a trusted match) asserting they
      // are aboard again — that outranks whatever they last got off.
      alightedFrom: null,
      boardingPrompt: {
        ...state.boardingPrompt,
        shown: false
      },
      vehicleMatch: {
        ...state.vehicleMatch,
        consecutiveMatches: 0,
        match: action.payload
      }
    }),

    [DISMISS_BOARDING_PROMPT]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        lastDismissedAt: Date.now(),
        shown: false
      }
    }),

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
      arrivedAt: action.payload
    }),

    [SET_DEPARTURE_OVERRIDE]: (state, action) => ({
      ...state,
      departureOverride: action.payload
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

    [SET_NOTIFICATION_CONFIG]: (state, action) => {
      return {
        ...state,
        notifications: {
          ...state.notifications,
          ...action.payload
        }
      }
    },

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
          pendingCandidates: isCounted ? payload.pendingCandidates ?? 0 : 0,
          status: options.length ? ('ready' as const) : ('error' as const)
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
        status: 'fetching-schedule' as const,
        vehicle: action.payload
      }
    }),

    [SET_REROUTE_RESULT]: (state, action) => {
      // Payload is the full list of alternatives (or null/[] for "none").
      // Only its emptiness is kept: nothing reads the itineraries back out.
      const found: boolean = Array.isArray(action.payload)
        ? action.payload.length > 0
        : action.payload != null
      return {
        ...state,
        reRoute: {
          ...state.reRoute,
          // Results resolved (or "none") — the auto-apply moment, if there
          // was one, has passed.
          autoApply: false,
          status: found ? ('found' as const) : ('none' as const)
        }
      }
    },

    [SET_RIDING]: (state, action) => ({
      ...state,
      alightedFrom: action.payload ? null : state.alightedFrom,
      riding: action.payload
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

    [SHOW_BOARDING_PROMPT]: (state) => ({
      ...state,
      boardingPrompt: {
        ...state.boardingPrompt,
        shown: true
      }
    }),

    [START_GO_MODE]: (state, action) => {
      const { itinerary, originalFrom } = action.payload

      // `ui` is deliberately preserved: a background auto-update (missed bus,
      // quiet access replan) swaps the itinerary via this action while the
      // rider may be browsing the planner — that must not clear
      // ui.backgrounded and yank them back to the Go Mode screen.
      return {
        ...state,
        activeItinerary: itinerary,
        arrivedAt: null,
        isActive: true,
        liveLegTimes: {},
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
              id.startsWith('BOARD_BUS_ARRIVING_')
          )
        },
        originalFrom: originalFrom ?? null,
        progress: null,
        reRoute: { ...defaultState.reRoute },
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
        riding: reanchorRiding(
          state.isActive || ridingFactIsEvidenced(state.riding)
            ? state.riding
            : null,
          itinerary
        ),
        routeMatch: null,
        tracking: {
          ...state.tracking,
          error: null,
          isTracking: true
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
        vehicleMatch: reanchorRiding(state.riding, itinerary)
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
        pendingCandidates: action.payload.candidates?.length ?? 0,
        status: 'optimizing' as const
      }
    }),

    [START_REROUTE]: (state, action) => ({
      ...state,
      reRoute: {
        autoApply: !!action.payload.autoApply,
        keepRouteId: action.payload.keepRouteId ?? null,
        reason: action.payload.reason ?? null,
        searchId: action.payload.searchId,
        startedAtMs: action.payload.startedAtMs ?? null,
        status: 'searching' as const
      }
    }),

    [STOP_GO_MODE]: (state) => ({
      ...defaultState,
      // Getting OFF a bus is just as physical, and it has to survive alongside
      // the confirmed match below — otherwise exiting Go Mode after an alight
      // hands the next onboard flow the match without the fact that disproves
      // it, which is the 8/9 hole through a different door.
      alightedFrom: state.alightedFrom,
      // Being aboard a bus is a physical fact; exiting the Go Mode screen
      // doesn't change it. On 7/12 the rider backed out and immediately
      // reopened "I'm on the bus" — with riding wiped here, the flow forgot
      // the confirmed vehicle and re-ran (failing) discovery. Alight and
      // sustained off-route remain the only physical invalidators.
      riding: state.riding,
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
              segmentIndex: 0
            }
          : null
      }
    },

    [UPDATE_NEARBY_VEHICLES]: (state: GoModeState, action: any) => ({
      ...state,
      vehicleMatch: {
        ...state.vehicleMatch,
        nearbyVehicles: action.payload
      }
    }),

    [UPDATE_POSITION]: (state: GoModeState, action: any) => {
      return {
        ...state,
        tracking: {
          ...state.tracking,
          error: null,
          lastPosition: action.payload
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
