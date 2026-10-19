/* globals describe, expect, it, jest */
import FakeTimers from '@sinonjs/fake-timers'
import polyline from '@mapbox/polyline'

import {
  confirmOnboardRoute,
  confirmTypedRoute,
  endGoMode,
  handlePositionUpdate,
  openChooseBusSheet
} from '../../lib/actions/go-mode'
import {
  convertPlanResponseItineraries,
  fetchOnboardCandidatePlan,
  findTrip,
  onboardGraphQLQuery
} from '../../lib/actions/apiV2'
import { fetchOnboardContext } from '../../lib/util/go-mode/onboard-discovery'
import goMode from '../../lib/reducers/go-mode'

jest.mock('../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  // The feed: nothing for the 546, as on the day (every
  // REALTIME_VEHICLE_POSITIONS_RESPONSE 09:47-09:57 was route 1:539 only).
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({})),
  onboardGraphQLQuery: jest.fn()
}))

// The transitnav sidecar's /api/onboard answer is not in the ride's record,
// so it is stubbed: the two routes whose shapes run along 98th St W under the
// rider (the 546 from Gate D, the plan's 539 from Gate C), neither with a live
// vehicle near them. `routes546` false drops the 546 for the typed-route test.
let mockSidecarHas546 = true
jest.mock('../../lib/util/go-mode/onboard-discovery', () => ({
  fetchOnboardContext: jest.fn(() =>
    Promise.resolve({
      routes: [
        ...(mockSidecarHas546
          ? [
              {
                color: '#771473',
                id: '1:546',
                shortName: '546',
                textColor: '#ffffff'
              }
            ]
          : []),
        {
          color: '#771473',
          id: '1:539',
          shortName: '539',
          textColor: '#ffffff'
        }
      ],
      vehicleDetails: {}
    })
  )
}))

jest.mock('../../lib/util/debug-log', () => ({
  ...jest.requireActual('../../lib/util/debug-log'),
  isTripRecordingEnabled: jest.fn(() => true)
}))

// The riding fact alone has to hold the quiet re-plan off. 26.6's transit-pace
// hold would also hold it in this window (that is its own fix, tested in
// transit-pace-hold-1013.ts), so it is switched off here: otherwise "no quiet
// re-plan follows the pick" would pass with or without this row.
jest.mock('../../lib/util/go-mode/deviation', () => ({
  ...jest.requireActual('../../lib/util/go-mode/deviation'),
  transitPaceHoldsAccessReplan: () => false
}))

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Backlog 51.1 — "On a different bus?": the rider names a bus the plan does not
 * hold and the realtime feed does not show.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Ride mv6ret6s-h5he2i, 2026-10-13 (`h5he2i-0952-transit-pace.json`, cut
 * 09:51:00-09:56:30). The plan: bike to I-35W & 98th Street Station Gate C,
 * 539 trip 1:895079 at 10:06:46 to 98th St W & Penn Ave S, bike on to 2345 Old
 * Shakopee Road West. The rider boarded a 546 instead (their answer to triage:
 * "it was the 546") and rode west on 98th St W from 09:52:19. The app had
 * polled only 1:539, so there was no vehicle match, no riding fact and no way
 * to say which bus it was; the quiet re-plans of 09:54:14 and 09:55:35 sent
 * the rider back to Gate C by bike.
 *
 * Here the rider says so from the access card at 09:53:10 (stopped at 98th St
 * W & Girard Ave S, 44.82640,-93.29763, the 546's 1:1617), by route badge and
 * by typing "546". The OTP answers (`__tests__/mocks/h5he2i-0953-route-546.json`; not a replay fixture, so not under replay/fixtures where the smoke test would replay it) are the
 * production OTP's for service day 2026-10-13, read 2026-10-14: realtime for
 * that day is gone, so the schedule resolver sees scheduled times only — the
 * 546 at 1:1617 at 09:22, 09:52 (trip 1:1133015, the run the day's own
 * REROUTE_SNAPSHOTs named) and 10:22.
 *
 * The candidate plans from the 546's alight stops onward are synthetic (a
 * straight bike leg at 5 m/s): the day never asked them, and the row is about
 * the pick and what it sets off, not the optimizer's ranking.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fx: any = require('../../lib/util/go-mode/replay/fixtures/h5he2i-0952-transit-pace.json')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const otp546: any = require('../mocks/h5he2i-0953-route-546.json')

const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
const mockedFindTrip = findTrip as jest.Mock
const mockedGraphQL = onboardGraphQLQuery as jest.Mock

const at = (hms: string) => Date.parse(`2026-10-13T${hms}-05:00`)
const PICK_AT = at('09:53:10')
const TRIP_546 = '1:1133015'

const positionOf = (fix: any): GeolocationPosition =>
  ({
    coords: {
      accuracy: fix.accuracy,
      altitude: null,
      altitudeAccuracy: null,
      heading: fix.heading,
      latitude: fix.lat,
      longitude: fix.lon,
      speed: fix.speed
    },
    timestamp: fix.tMs
  } as GeolocationPosition)

const haversine = (a: any, b: any) => {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** A straight bike leg at 5 m/s from an alight stop to the destination. */
function bikeOnward(from: any, to: any, startMs: number) {
  const distance = haversine(from, to) * 1.3
  const duration = Math.round(distance / 5)
  const endMs = startMs + duration * 1000
  const leg = {
    distance,
    duration,
    endTime: endMs,
    from: {
      lat: from.lat,
      lon: from.lon,
      name: from.name,
      vertexType: 'NORMAL'
    },
    interlineWithPreviousLeg: false,
    intermediateStops: null,
    legGeometry: {
      length: 2,
      points: polyline.encode([
        [from.lat, from.lon],
        [to.lat, to.lon]
      ])
    },
    mode: 'BICYCLE',
    realTime: false,
    rentedBike: false,
    startTime: startMs,
    steps: [],
    to: { lat: to.lat, lon: to.lon, name: to.name, vertexType: 'NORMAL' },
    transitLeg: false
  }
  return {
    duration,
    endTime: endMs,
    legs: [leg],
    startTime: startMs,
    transfers: 0,
    walkDistance: 0
  }
}

const initial = goMode(undefined, { type: '@@INIT' })

function itineraryAt(tMs: number): any {
  let best = fx.itinerary
  for (const s of fx.itinerarySwaps ?? []) if (s.tMs <= tMs) best = s.itinerary
  return best
}

/**
 * The ride, fix by fix through the real tick, with the store reduced through
 * the real Go Mode reducer — the 26.6 replay's harness, plus what the pick
 * adds to the transit index (the nearby routes, the 546's trip).
 */
function harness() {
  let goModeState: any = {
    ...initial,
    activeItinerary: itineraryAt(fx.meta.startMs),
    isActive: true,
    tracking: { ...initial.tracking, lastPosition: null }
  }
  let nowMs = 0
  const actions: any[] = []
  const extraTrips: Record<string, any> = {}
  let nearbyRoutes: any[] = []
  const latestBy = (rows: any[], key: string) => {
    const out: Record<string, any> = {}
    const seen: Record<string, number> = {}
    for (const row of rows ?? []) {
      const id = row[key]
      if (row.tMs > nowMs || (seen[id] != null && seen[id] > row.tMs)) continue
      seen[id] = row.tMs
      out[id] = row.payload
    }
    return out
  }
  const vehiclesAt = (routeId: string) => {
    let best: any = null
    for (const snap of fx.vehicleSnapshots ?? []) {
      if (snap.routeId !== routeId) continue
      if (snap.tMs <= nowMs && (!best || snap.tMs > best.tMs)) best = snap
    }
    return best?.payload?.vehicles ?? []
  }
  const getState = () => ({
    otp: {
      config: { homeTimezone: 'America/Chicago' },
      currentQuery: {},
      goMode: goModeState,
      transitIndex: {
        nearbyRoutes,
        routes: Object.fromEntries(
          ['1:539', '1:904', '1:546'].map((r) => [
            r,
            { vehicles: vehiclesAt(r) }
          ])
        ),
        stops: latestBy(fx.stopTimeSnapshots, 'stopId'),
        trips: { ...latestBy(fx.tripSnapshots, 'tripId'), ...extraTrips }
      }
    }
  })
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push({ ...action, atMs: nowMs })
    if (action.type === 'NEARBY_ROUTES_RESPONSE') {
      nearbyRoutes = action.payload.routes
    }
    goModeState = goMode(goModeState, action)
    return action
  }

  // findTrip: the 546 run from OTP; anything else as the ride recorded it.
  mockedFindTrip.mockImplementation((params: any) => () => {
    if (params?.tripId === TRIP_546) extraTrips[TRIP_546] = otp546.trip1133015
    return Promise.resolve({})
  })
  // The schedule resolver's two questions and the typed box's one.
  mockedGraphQL.mockImplementation((query: string) => () => {
    if (/route\(id: "1:546"\)/.test(query)) {
      return Promise.resolve(otp546.route546Patterns)
    }
    if (/stop\(id: "1:1617"\)/.test(query)) {
      return Promise.resolve(otp546.stopTimes1617)
    }
    if (/routes\(name: "546"\)/.test(query)) {
      return Promise.resolve(otp546.routesByName546)
    }
    return Promise.resolve({ data: { routes: [] } })
  })
  const destination = fx.itinerary.legs[fx.itinerary.legs.length - 1].to
  const stops546 = otp546.trip1133015.stopTimes
  mockedFetch.mockImplementation((combo: any) => () => {
    // An onward plan from one of the 546's stops (the alight optimizer).
    const alight = stops546.find(
      (st: any) =>
        Math.abs(st.stop.lat - combo?.from?.lat) < 1e-6 &&
        Math.abs(st.stop.lon - combo?.from?.lon) < 1e-6
    )
    if (alight) {
      // From the bus's arrival there. With no realtime the optimizer carries
      // the run's lateness at the rider's stop downstream (09:52:00 scheduled
      // at Girard, picked at 09:53:10: 70 s), so the onward plan starts then.
      const girard = stops546.find((st: any) => st.stop.id === '1:1617')
      const lateMs = Math.max(
        0,
        PICK_AT - (girard.serviceDay + girard.scheduledArrival) * 1000
      )
      const startMs =
        (alight.serviceDay + alight.scheduledArrival) * 1000 + lateMs
      return Promise.resolve({
        error: false,
        itineraries: [
          bikeOnward(
            { ...combo.from, name: alight.stop.name },
            destination,
            startMs
          )
        ],
        query: '',
        response: null,
        variables: {}
      })
    }
    // The scoped quiet re-plan gets what OTP answered on the day.
    const scoped =
      (combo?.modes || []).length > 0 &&
      combo.modes.every((m: any) => m.mode === 'BICYCLE' || m.mode === 'WALK')
    const rec = scoped
      ? (fx.quietReplanPlans || []).find(
          (q: any) =>
            q.reason === 'quiet-replan-scoped' &&
            q.tMs >= nowMs &&
            q.tMs - nowMs < 5000
        )
      : null
    const response = rec?.response ?? { data: { plan: { itineraries: [] } } }
    return Promise.resolve({
      error: false,
      itineraries:
        convertPlanResponseItineraries(response, {
          combo,
          config: {},
          query: {},
          strictModes: false,
          validModeCombinations: []
        }) || [],
      query: '',
      response,
      variables: {}
    })
  })

  const clock = FakeTimers.install({
    now: fx.meta.startMs - 1000,
    toFake: ['Date']
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const ticks: any[] = []
  return {
    actions,
    /** Replay the fixes in [fromMs, toMs]. */
    async ride(fromMs: number, toMs: number) {
      for (const fix of fx.gpsTrack) {
        if (fix.tMs < fromMs || fix.tMs > toMs) continue
        clock.setSystemTime(fix.tMs)
        nowMs = fix.tMs
        await dispatch(handlePositionUpdate(positionOf(fix)))
        await settle()
        ticks.push({
          legIndex: goModeState.routeMatch?.legIndex,
          riding: goModeState.riding?.tripId ?? null,
          tMs: fix.tMs
        })
      }
    },

    state: () => goModeState,

    stop() {
      dispatch(endGoMode())
      clock.uninstall()
    },
    /** A tap, at the clock of the last fix replayed. */
    async tap(thunk: any) {
      await dispatch(thunk)
      for (let i = 0; i < 5; i++) await settle()
    },
    ticks
  }
}

const quietReplans = (actions: any[], fromMs: number) =>
  actions.filter(
    (a) =>
      a.atMs > fromMs &&
      a.type === 'AUTO_REPLAN' &&
      String(a.payload?.reason ?? '').startsWith('quiet-replan')
  )

describe('go-mode > 2026-10-13 09:53, "On a different bus?" names the 546 (51.1)', () => {
  it('control: with nothing said, the quiet re-plans send the rider back to Gate C', async () => {
    // What the row is about, reproduced with the transit-pace hold off: the
    // tick has nothing to tell it the rider is on a bus.
    const h = harness()
    try {
      await h.ride(fx.meta.startMs, at('09:56:00'))
      const quiet = quietReplans(h.actions, PICK_AT)
      expect(quiet.length).toBeGreaterThan(0)
      expect(quiet[0].payload.accepted).toBe(true)
      expect(h.state().riding).toBeNull()
    } finally {
      h.stop()
    }
  })

  describe('picked by its route badge', () => {
    let result: any = null
    const run = async () => {
      if (result) return result
      const h = harness()
      try {
        await h.ride(fx.meta.startMs, PICK_AT)
        const before = h.state()
        await h.tap(openChooseBusSheet())
        const sheet = h.state().boardingPrompt
        const nearby = h.state().vehicleMatch.nearbyVehicles
        await h.tap(confirmOnboardRoute('1:546'))
        const afterPick = h.state()
        await h.ride(PICK_AT + 1, fx.meta.endMs)
        result = {
          actions: h.actions,
          afterPick,
          before,
          end: h.state(),
          nearby,
          sheet,
          ticks: h.ticks
        }
      } finally {
        h.stop()
      }
      return result
    }

    it('reaches the moment: on the bike leg to Gate C, no riding fact, no match', async () => {
      const { before } = await run()
      expect(before.routeMatch.legIndex).toBe(0)
      expect(before.activeItinerary.legs[0].mode).toBe('BICYCLE')
      expect(before.activeItinerary.legs[1].routeShortName).toBe('539')
      expect(before.riding).toBeNull()
      // As on the day: UPDATE_VEHICLE_MATCH confidence "none" throughout.
      expect(before.vehicleMatch.match?.confidence ?? 'none').toBe('none')
    })

    it('opens the sheet in choose-bus mode, searched across every nearby route', async () => {
      const { actions, nearby, sheet } = await run()
      expect(sheet).toEqual(
        expect.objectContaining({
          chooseBus: true,
          searching: false,
          shown: true
        })
      )
      // Every route's live buses are listed — here only a 539 going the
      // other way (SL-60147, eastbound, 444 m) — and the feed has no 546 to
      // list, so the route badge is the way in.
      expect(nearby.map((v: any) => v.routeId)).not.toContain('1:546')
      expect(nearby.map((v: any) => v.vehicleId)).toEqual(['1:SL-60147'])
      expect(fetchOnboardContext).toHaveBeenCalled()
      expect(
        actions
          .find((a: any) => a.type === 'NEARBY_ROUTES_RESPONSE')
          ?.payload.routes.map((r: any) => r.shortName)
      ).toEqual(['546', '539'])
      // It is the rider's own flow, not the onboard one.
      expect(
        actions.some(
          (a: any) => a.type === 'SET_ONBOARD_STATUS' && a.atMs <= PICK_AT
        )
      ).toBe(false)
    })

    it('resolves route 546 to schedule trip 1:1133015 and sets a riding fact on it', async () => {
      const { actions, afterPick } = await run()
      const confirm = actions.find((a: any) => a.type === 'CONFIRM_VEHICLE')
      expect(confirm.payload).toEqual(
        expect.objectContaining({
          confidence: 'confirmed',
          routeId: '1:546',
          tripId: TRIP_546,
          vehicleId: 'route:1:546'
        })
      )
      const riding = actions.find(
        (a: any) => a.type === 'SET_RIDING' && a.payload?.routeId === '1:546'
      )
      expect(riding.payload).toEqual(
        expect.objectContaining({
          routeShortName: '546',
          tripId: TRIP_546
        })
      )
      expect(riding.payload.boardedAt).toBe(PICK_AT)
      expect(afterPick.boardingPrompt.shown).toBe(false)
      expect(
        actions.find(
          (a: any) =>
            a.type === 'GO_MODE_CONTROL_TAP' &&
            a.payload?.control === 'choose-bus-pick'
        )?.payload
      ).toEqual(
        expect.objectContaining({
          how: 'route',
          routeId: '1:546',
          tripId: TRIP_546
        })
      )
    })

    it('runs a rider-picked-bus aboard re-plan that puts the rider on the 546', async () => {
      const { actions, afterPick } = await run()
      const start = actions.find(
        (a: any) =>
          a.type === 'START_REROUTE' && a.payload?.reason === 'rider-picked-bus'
      )
      expect(start.payload).toEqual(
        expect.objectContaining({ autoApply: true, keepRouteId: null })
      )
      const verdict = actions.find(
        (a: any) =>
          a.type === 'AUTO_REPLAN' && a.payload?.reason === 'rider-picked-bus'
      )
      expect(verdict.payload.accepted).toBe(true)
      const legs = afterPick.activeItinerary.legs
      expect(legs[0]).toEqual(
        expect.objectContaining({ mode: 'BUS', transitLeg: true })
      )
      expect(legs[0].trip?.gtfsId ?? legs[0].tripId).toBe(TRIP_546)
      // Boarded where the rider stood at the pick. Where it alights follows
      // from the synthetic onward plans (Old Shakopee Rd & Queen Ave S, then
      // a short bike leg: arriving 09:57:32 against the day's SET_ARRIVED at
      // 09:57:28) and is not what this row pins.
      expect(legs[0].from.name).toBe('98th St W & Girard Ave S')
      expect(legs[legs.length - 1].to.name).toMatch(/2345 Old Shakopee/)
      // No bike leg back to Gate C anywhere in the new plan, and no 539.
      expect(legs.some((l: any) => /Gate C/.test(l.to?.name ?? ''))).toBe(false)
      expect(legs.some((l: any) => l.routeShortName === '539')).toBe(false)
      expect(afterPick.riding).toEqual(
        expect.objectContaining({ legIndex: 0, tripId: TRIP_546 })
      )
    })

    it('no quiet re-plan follows, and the riding fact holds to the end of the record', async () => {
      const { actions, end, ticks } = await run()
      expect(quietReplans(actions, PICK_AT)).toHaveLength(0)
      // One swap after the pick: the pick's own.
      const swaps = actions.filter(
        (a: any) => a.type === 'START_GO_MODE' && a.atMs >= PICK_AT
      )
      expect(swaps).toHaveLength(1)
      const after = ticks.filter((t: any) => t.tMs > PICK_AT)
      expect(after.length).toBeGreaterThan(100)
      expect(after.every((t: any) => t.riding === TRIP_546)).toBe(true)
      expect(end.riding?.tripId).toBe(TRIP_546)
    })
  })

  describe('typed as "546"', () => {
    it('resolves through OTP when the route is not among the badges, to the same trip', async () => {
      mockSidecarHas546 = false
      const h = harness()
      try {
        await h.ride(fx.meta.startMs, PICK_AT)
        await h.tap(openChooseBusSheet())
        expect(
          (
            h.actions.find((a: any) => a.type === 'NEARBY_ROUTES_RESPONSE')
              ?.payload.routes || []
          ).map((r: any) => r.shortName)
        ).toEqual(['539'])
        await h.tap(confirmTypedRoute(' 546 '))
        const riding = h.state().riding
        expect(riding).toEqual(
          expect.objectContaining({
            routeId: '1:546',
            routeShortName: '546',
            tripId: TRIP_546
          })
        )
        expect(
          h.actions.find(
            (a: any) =>
              a.type === 'GO_MODE_CONTROL_TAP' &&
              a.payload?.control === 'choose-bus-pick'
          )?.payload.how
        ).toBe('typed')
        expect(
          h.actions.find(
            (a: any) =>
              a.type === 'AUTO_REPLAN' &&
              a.payload?.reason === 'rider-picked-bus'
          )?.payload.accepted
        ).toBe(true)
        await h.ride(PICK_AT + 1, at('09:56:00'))
        expect(quietReplans(h.actions, PICK_AT)).toHaveLength(0)
      } finally {
        h.stop()
        mockSidecarHas546 = true
      }
    })

    it('a route that does not exist is said on the sheet and changes nothing', async () => {
      const h = harness()
      try {
        await h.ride(fx.meta.startMs, PICK_AT)
        await h.tap(openChooseBusSheet())
        const plan = h.state().activeItinerary
        await h.tap(confirmTypedRoute('9999'))
        expect(h.state().boardingPrompt).toEqual(
          expect.objectContaining({
            chooseBus: true,
            chooseBusError: { kind: 'no-route', route: '9999' },
            shown: true
          })
        )
        expect(h.state().riding).toBeNull()
        expect(h.state().activeItinerary).toBe(plan)
      } finally {
        h.stop()
      }
    })
  })
})
