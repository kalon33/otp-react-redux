/* globals afterEach, beforeEach, describe, expect, it, jest */
import polyline from '@mapbox/polyline'

import {
  answerOnboardStopChoice,
  beginOnboardFlowAction,
  confirmOnboardAlightStop,
  loadOnboardScheduleAndOptimize,
  openOnboardAlightPreview,
  setOnboardVehicle,
  stopVehicleTracking
} from '../../../lib/actions/go-mode'
import { fetchOnboardCandidatePlan } from '../../../lib/actions/apiV2'
import {
  ONBOARD_STOP_PASSED_MARGIN_M,
  onboardMultiStopStart,
  onboardStopsFromQuery,
  passedOnboardStops
} from '../../../lib/util/go-mode/onboard-stops'
import goMode from '../../../lib/reducers/go-mode'
import type { OnboardStop } from '../../../lib/util/go-mode/onboard-stops'

jest.mock('../../../lib/actions/apiV2', () => ({
  ...jest.requireActual('../../../lib/actions/apiV2'),
  fetchOnboardCandidatePlan: jest.fn(),
  // beginGoMode pre-fetches stop times and starts vehicle tracking for a
  // transit first leg — no-op thunks keep the confirm off the network.
  findStopTimesForStop: jest.fn(() => () => Promise.resolve({})),
  findTrip: jest.fn(() => () => Promise.resolve({})),
  getBasePlanParts: jest.fn(() => ({
    modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
    modeSettings: [],
    numItineraries: 5
  })),
  getVehiclePositionsForRoute: jest.fn(() => () => Promise.resolve({}))
}))

/**
 * Backlog 63.1 — "I'm already on the bus" drops the stop the rider added.
 *
 * 2026-10-20, session `mvgplnrw-yvtqga`, DEV `2026.1020.2`, twice (08:19 and
 * 08:32): the search carried `intermediatePlaces=3322 Columbus Avenue` with
 * `stopStays=5`; every ONBOARD_CANDIDATE_SNAPSHOT went straight to 3510 Hopkins
 * Place with no via, and START_GO_MODE had `multiStop: null`. The rider's
 * answer (Q2 = C): "Ask me each time" — but only when the bus has genuinely
 * left the stop behind; a stop still ahead is just kept.
 *
 * Synthetic run: a straight southbound line on lon -93.27, a stop every
 * 0.01° of latitude (~1.1 km), the rider at 44.935 between s5 and s6.
 */
const LON = -93.27
const TRIP_ID = '1:trip-1020'
const stopLat = (i: number) => +(44.99 - i * 0.01).toFixed(4)
const STOPS = Array.from({ length: 13 }, (_, i) => ({
  code: `s${i}`,
  id: `1:s${i}`,
  lat: stopLat(i),
  lon: LON,
  name: `Stop ${i}`
}))
const TRIP = {
  geometry: {
    points: polyline.encode(STOPS.map((s) => [s.lat, s.lon]))
  },
  id: TRIP_ID,
  route: { id: '1:904', mode: 'BUS', shortName: 'Orange' },
  stopTimes: STOPS.map((stop, i) => ({
    scheduledArrival: 30000 + i * 120,
    scheduledDeparture: 30000 + i * 120,
    serviceDay: 0,
    stop
  })),
  tripHeadsign: 'Burnsville'
}
const HOME = { lat: 44.86, lon: -93.3, name: 'Home' }

/** ~470 m west of the line, south of the rider: the bus still reaches it. */
const AHEAD: OnboardStop = {
  lat: 44.905,
  lon: -93.276,
  name: 'Ahead Ave',
  stayMinutes: 5
}
/** ~590 m off the line, north of the rider (the Columbus shape). */
const BEHIND: OnboardStop = {
  lat: 44.955,
  lon: -93.2775,
  name: '3322 Columbus Avenue',
  stayMinutes: 5
}
/** 1.6 km west, level with the rider: as near on either side. */
const BROADSIDE: OnboardStop = {
  lat: 44.936,
  lon: -93.29,
  name: 'Broadside St',
  stayMinutes: 0
}

const fixAt = (lat: number, lon = LON) => ({
  coords: { accuracy: 10, latitude: lat, longitude: lon },
  timestamp: Date.now()
})

/** One onward plan from the candidate stop, through the via (if any). */
const onwardFor = (combo: any) => {
  const start = Date.now() + 30 * 60000
  const places: any[] = combo.intermediatePlaces || []
  const legs: any[] = []
  let from = combo.from
  let t = start
  places.forEach((p: any) => {
    const to = {
      lat: p.lat,
      lon: p.lon,
      name: `${p.name} (${p.lat}, ${p.lon})`
    }
    legs.push({
      distance: 600,
      endTime: t + 8 * 60000,
      from,
      mode: 'WALK',
      startTime: t,
      to,
      transitLeg: false
    })
    from = to
    t += 8 * 60000
  })
  legs.push({
    distance: 4000,
    endTime: t + 15 * 60000,
    from,
    mode: 'BICYCLE',
    startTime: t,
    to: combo.to,
    transitLeg: false
  })
  return {
    duration: (t + 15 * 60000 - start) / 1000,
    endTime: t + 15 * 60000,
    legs,
    startTime: start,
    transfers: 0,
    walkDistance: places.length * 600
  }
}

const flush = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms))

describe('onboard flow through the rider’s added stops (63.1)', () => {
  const mockedFetch = fetchOnboardCandidatePlan as jest.Mock
  const initial = goMode(undefined, { type: '@@INIT' })

  const makeStore = ({
    nextStopId = null,
    position = fixAt(44.935)
  }: {
    nextStopId?: string | null
    position?: any
  } = {}) => {
    let state: any = {
      ...initial,
      tracking: { ...initial.tracking, lastPosition: position }
    }
    const actions: any[] = []
    const getState = () => ({
      otp: {
        config: {
          homeTimezone: 'America/Chicago',
          itinerary: { onboardAnchorWaitMs: 30, onboardSettleMs: 60 }
        },
        currentQuery: { to: HOME },
        goMode: state,
        transitIndex: { routes: {}, trips: { [TRIP_ID]: TRIP } }
      }
    })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      state = goMode(state, action)
      return action
    }
    const vehicle = {
      label: 'Orange',
      nextStopId,
      routeId: '1:904',
      tripId: TRIP_ID,
      vehicleId: '1:8222'
    }
    return {
      actions,
      combos: () => mockedFetch.mock.calls.map((call) => call[0]),
      /** Preview the list's top option and Confirm it. */
      async confirmTop() {
        const option = state.onboard.alightOptions[0]
        dispatch(openOnboardAlightPreview(option, 'row'))
        await dispatch(confirmOnboardAlightStop())
        await flush()
      },

      dispatch,

      of: (type: string) => actions.filter((a) => a.type === type),

      onboard: () => state.onboard,

      /** Open the flow with these stops and run it to the list or the card. */
      async open(stops: OnboardStop[]) {
        dispatch(beginOnboardFlowAction({ keepRouteId: null, stops }))
        dispatch(setOnboardVehicle(vehicle))
        await dispatch(loadOnboardScheduleAndOptimize(TRIP_ID))
        await flush()
      },

      setFix: (fix: any) => {
        state = { ...state, tracking: { ...state.tracking, lastPosition: fix } }
      },
      startPayload: () => {
        const starts = actions.filter((a) => a.type === 'START_GO_MODE')
        return starts[starts.length - 1]?.payload
      }
    }
  }

  beforeEach(() => {
    mockedFetch.mockReset()
    mockedFetch.mockImplementation(
      (combo: any) => () =>
        Promise.resolve({ error: false, itineraries: [onwardFor(combo)] })
    )
  })
  afterEach(() => {
    stopVehicleTracking()(() => undefined)
  })

  it('a stop still ahead: no card, every candidate goes through it, the trip is multi-stop', async () => {
    // FAILS BEFORE: the 08:19:19–08:19:25 snapshots carried no via, and the
    // 08:19:32 START_GO_MODE had multiStop: null.
    const store = makeStore()
    await store.open([AHEAD])

    expect(store.of('SET_ONBOARD_STOP_CHOICE')).toHaveLength(0)
    expect(store.onboard().status).toBe('ready')
    expect(store.combos().length).toBeGreaterThan(0)
    store.combos().forEach((combo: any) => {
      expect(combo.intermediatePlaces).toEqual([
        { lat: AHEAD.lat, lon: AHEAD.lon, name: AHEAD.name }
      ])
      expect(combo.stopStays).toEqual([5])
    })
    // The candidates are picked around the stop the rider is going to next,
    // not the destination: the stop nearest Ahead Ave (s8/s9) is asked.
    const asked = store.combos().map((c: any) => c.from.name)
    expect(asked).toContain('Stop 9')

    await store.confirmTop()
    const start = store.startPayload()
    expect(start.multiStop).not.toBeNull()
    expect(start.multiStop.segments).toHaveLength(2)
    expect(start.multiStop.stopNames[0]).toBe('Ahead Ave')
    // Segment 0 is what Go Mode guides now: the bus, then the walk to the stop.
    expect(start.itinerary.legs[0].transitLeg).toBe(true)
    const seg0Legs = start.multiStop.segments[0].legs
    expect(seg0Legs[seg0Legs.length - 1].to.name).toBe('Ahead Ave')
  })

  it('a stop the bus has passed: the card, and no candidate asked before the answer', async () => {
    const store = makeStore()
    await store.open([BEHIND])

    const asks = store.of('SET_ONBOARD_STOP_CHOICE')
    expect(asks).toHaveLength(1)
    expect(asks[0].payload.passedStops.map((s: any) => s.name)).toEqual([
      '3322 Columbus Avenue'
    ])
    expect(store.onboard().status).toBe('added-stop-choice')
    expect(store.onboard().stopChoiceFor).toBe('list')
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('Keep: the candidates go through it, and the trip is multi-stop', async () => {
    const store = makeStore()
    await store.open([BEHIND])
    store.dispatch(answerOnboardStopChoice(true))
    await flush()

    expect(store.onboard().stops).toEqual([{ ...BEHIND, kept: true }])
    expect(store.combos().length).toBeGreaterThan(0)
    store.combos().forEach((combo: any) => {
      expect(combo.intermediatePlaces).toEqual([
        { lat: BEHIND.lat, lon: BEHIND.lon, name: BEHIND.name }
      ])
      expect(combo.stopStays).toEqual([5])
    })
    // Picked around the stop: the first stops still ahead of the bus.
    expect(store.combos().map((c: any) => c.from.name)).toContain('Stop 6')

    await store.confirmTop()
    // Asked once: a stop already answered is never asked about again.
    expect(store.of('SET_ONBOARD_STOP_CHOICE')).toHaveLength(1)
    const start = store.startPayload()
    expect(start.multiStop?.stopNames?.[0]).toBe('3322 Columbus Avenue')
    expect(start.multiStop.segments).toHaveLength(2)
  })

  it('Skip: no via, and the trip starts with no multi-stop plan', async () => {
    const store = makeStore()
    await store.open([BEHIND])
    store.dispatch(answerOnboardStopChoice(false))
    await flush()

    expect(store.onboard().stops).toEqual([])
    expect(store.combos().length).toBeGreaterThan(0)
    store.combos().forEach((combo: any) => {
      expect(combo.intermediatePlaces).toBeUndefined()
    })

    await store.confirmTop()
    const start = store.startPayload()
    expect(start).toBeTruthy()
    expect(start.multiStop).toBeNull()
  })

  it('two stops, one behind: only that one is asked about; Keep sends both in order', async () => {
    const store = makeStore()
    await store.open([BEHIND, AHEAD])

    const asks = store.of('SET_ONBOARD_STOP_CHOICE')
    expect(asks).toHaveLength(1)
    expect(asks[0].payload.passedStops.map((s: any) => s.name)).toEqual([
      '3322 Columbus Avenue'
    ])
    store.dispatch(answerOnboardStopChoice(true))
    await flush()
    store.combos().forEach((combo: any) => {
      expect(combo.intermediatePlaces.map((p: any) => p.name)).toEqual([
        '3322 Columbus Avenue',
        'Ahead Ave'
      ])
      expect(combo.stopStays).toEqual([5, 5])
    })
    await store.confirmTop()
    expect(store.startPayload().multiStop.segments).toHaveLength(3)
  })

  it('no fix and no next stop: never asks — the stop is kept', async () => {
    const store = makeStore({ nextStopId: null, position: null })
    await store.open([BEHIND])
    expect(store.of('SET_ONBOARD_STOP_CHOICE')).toHaveLength(0)
    expect(store.onboard().passedStops).toBeNull()
    expect(store.onboard().stops).toEqual([BEHIND])
  })

  it('no fix, but the bus’s next stop places it: asks', async () => {
    const store = makeStore({ nextStopId: '1:s6', position: null })
    await store.open([BEHIND])
    expect(store.of('SET_ONBOARD_STOP_CHOICE')).toHaveLength(1)
  })

  describe('the stop goes behind the bus between the list and the Confirm', () => {
    const toConfirm = async () => {
      const store = makeStore()
      await store.open([AHEAD])
      expect(store.of('SET_ONBOARD_STOP_CHOICE')).toHaveLength(0)
      // The bus rides on past Ahead Ave (44.905) before the rider confirms;
      // the stop they chose (s10 or beyond, 44.89 or south) is still ahead.
      store.setFix(fixAt(44.893))
      const option = store
        .onboard()
        .alightOptions.find((o: any) => Number(o.stopId.slice(3)) >= 10)
      expect(option).toBeTruthy()
      store.dispatch(openOnboardAlightPreview(option, 'row'))
      await store.dispatch(confirmOnboardAlightStop())
      await flush()
      return store
    }

    it('the same card goes up over the preview, and nothing starts', async () => {
      const store = await toConfirm()
      const asks = store.of('SET_ONBOARD_STOP_CHOICE')
      expect(asks).toHaveLength(1)
      expect(asks[0].payload.stopChoiceFor).toBe('confirm')
      expect(store.onboard().preview).not.toBeNull()
      expect(store.startPayload()).toBeUndefined()
    })

    it('Keep starts the chosen stop, through the added stop', async () => {
      const store = await toConfirm()
      store.dispatch(answerOnboardStopChoice(true))
      await flush()
      const start = store.startPayload()
      expect(start.multiStop?.stopNames?.[0]).toBe('Ahead Ave')
      expect(store.of('SET_ONBOARD_STOP_CHOICE')).toHaveLength(1)
    })

    it('Skip re-asks without the stop, then starts with no multi-stop plan', async () => {
      const store = await toConfirm()
      const before = store.combos().length
      store.dispatch(answerOnboardStopChoice(false))
      await flush(300)
      const reasked = store.combos().slice(before)
      expect(reasked.length).toBeGreaterThan(0)
      reasked.forEach((combo: any) =>
        expect(combo.intermediatePlaces).toBeUndefined()
      )
      const start = store.startPayload()
      expect(start).toBeTruthy()
      expect(start.multiStop).toBeNull()
      // Never a second ask for the same stop.
      expect(store.of('SET_ONBOARD_STOP_CHOICE')).toHaveLength(1)
    })

    it('Back while the card is up drops it with the preview', async () => {
      const store = await toConfirm()
      store.dispatch({ type: 'CLOSE_ONBOARD_PREVIEW' })
      expect(store.onboard().passedStops).toBeNull()
      expect(store.onboard().stopChoiceFor).toBeNull()
      // Still undecided: the next Confirm asks again.
      expect(store.onboard().stops[0].kept).toBeUndefined()
    })
  })
})

describe('passedOnboardStops — which side of the rider the run came nearest (63.1)', () => {
  const at = (lat: number) => ({
    lastPosition: fixAt(lat),
    nowMs: Date.now(),
    trip: TRIP
  })

  it('behind the rider by more than the margin is passed', () => {
    expect(passedOnboardStops({ ...at(44.935), stops: [BEHIND] })).toEqual([
      BEHIND
    ])
  })

  it('ahead of the rider is not', () => {
    expect(passedOnboardStops({ ...at(44.935), stops: [AHEAD] })).toEqual([])
  })

  it('level with the rider, far off the line, is not (no absolute threshold, and no coin toss)', () => {
    expect(ONBOARD_STOP_PASSED_MARGIN_M).toBe(150)
    expect(passedOnboardStops({ ...at(44.935), stops: [BROADSIDE] })).toEqual(
      []
    )
  })

  it('a stop the rider has already kept is never offered again', () => {
    expect(
      passedOnboardStops({ ...at(44.935), stops: [{ ...BEHIND, kept: true }] })
    ).toEqual([])
  })

  it('a coarse fix says nothing; the next stop then places the rider', () => {
    const coarse = {
      coords: { accuracy: 1400, latitude: 44.935, longitude: LON },
      timestamp: Date.now()
    }
    const input = { lastPosition: coarse, nowMs: Date.now(), trip: TRIP }
    expect(passedOnboardStops({ ...input, stops: [BEHIND] })).toEqual([])
    expect(
      passedOnboardStops({ ...input, nextStopId: '1:s6', stops: [BEHIND] })
    ).toEqual([BEHIND])
  })

  it('without a trip shape the line through its stops stands in', () => {
    const { geometry, ...noShape } = TRIP
    expect(geometry).toBeTruthy()
    expect(
      passedOnboardStops({ ...at(44.935), stops: [BEHIND], trip: noShape })
    ).toEqual([BEHIND])
  })
})

describe('onboard stops — capture and the trip start (63.1)', () => {
  it('takes the stops and stays off the query, minus the ones a live trip reached', () => {
    const query = {
      intermediatePlaces: [
        { lat: 44.95, lon: -93.27, name: 'A' },
        {},
        { lat: 44.9, lon: -93.27, name: 'B' }
      ],
      stopStays: [5, 0, 15]
    }
    // queryStops drops the empty placeholder, as the planner's own via does.
    expect(onboardStopsFromQuery(query).map((s) => s.name)).toEqual(['A', 'B'])
    expect(onboardStopsFromQuery(query, ['A']).map((s) => s.name)).toEqual([
      'B'
    ])
  })

  it('a stop OTP did not route through leaves no plan, and no stale marks', () => {
    const itinerary: any = {
      legs: [
        { from: { name: 'x' }, mode: 'BUS', to: { lat: 1, lon: 1 } },
        { from: { lat: 1, lon: 1 }, mode: 'BICYCLE', to: HOME }
      ],
      // Marks from the plan this was cut from — wrong indexes here.
      stopLegIndexes: [0]
    }
    const out = onboardMultiStopStart(itinerary, [AHEAD])
    expect(out.multiStop).toBeNull()
    expect(out.itinerary).toBe(itinerary)
  })
})

describe('reducer — the added-stop card (63.1)', () => {
  const initial = goMode(undefined, { type: '@@INIT' })
  const opened = goMode(
    initial,
    beginOnboardFlowAction({ keepRouteId: null, stops: [BEHIND, AHEAD] })
  )

  it('BEGIN_ONBOARD_FLOW carries the stops; the default is null (not captured)', () => {
    expect(initial.onboard.stops).toBeNull()
    expect(opened.onboard.stops).toEqual([BEHIND, AHEAD])
    expect(goMode(initial, beginOnboardFlowAction({})).onboard.stops).toEqual(
      []
    )
  })

  it('SET_ONBOARD_STOP_CHOICE from the flow is its own status', () => {
    const asked = goMode(opened, {
      payload: { passedStops: [BEHIND], stopChoiceFor: 'list' },
      type: 'SET_ONBOARD_STOP_CHOICE'
    })
    expect(asked.onboard.status).toBe('added-stop-choice')
    expect(asked.onboard.passedStops).toEqual([BEHIND])
  })

  it('Keep marks the stop; Skip removes it; both clear the card', () => {
    const asked = goMode(opened, {
      payload: { passedStops: [BEHIND], stopChoiceFor: 'list' },
      type: 'SET_ONBOARD_STOP_CHOICE'
    })
    const kept = goMode(asked, {
      payload: { keep: true },
      type: 'ANSWER_ONBOARD_STOP_CHOICE'
    })
    expect(kept.onboard.stops).toEqual([{ ...BEHIND, kept: true }, AHEAD])
    expect(kept.onboard.passedStops).toBeNull()
    expect(kept.onboard.status).toBe('optimizing')
    const skipped = goMode(asked, {
      payload: { keep: false },
      type: 'ANSWER_ONBOARD_STOP_CHOICE'
    })
    expect(skipped.onboard.stops).toEqual([AHEAD])
  })

  it('from the Confirm the status (and the preview) stand', () => {
    const ready = { ...opened, onboard: { ...opened.onboard, status: 'ready' } }
    const asked = goMode(ready as any, {
      payload: { passedStops: [AHEAD], stopChoiceFor: 'confirm' },
      type: 'SET_ONBOARD_STOP_CHOICE'
    })
    expect(asked.onboard.status).toBe('ready')
  })

  it('the full otp reducer passes both actions through (create-otp-reducer list)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const createOtpReducer =
      require('../../../lib/reducers/create-otp-reducer').default
    const reducer = createOtpReducer({
      api: {},
      homeTimezone: 'America/Chicago',
      persistence: { enabled: false }
    })
    let otp = reducer(undefined, { type: '@@INIT' })
    otp = reducer(
      otp,
      beginOnboardFlowAction({ keepRouteId: null, stops: [BEHIND] })
    )
    otp = reducer(otp, {
      payload: { passedStops: [BEHIND], stopChoiceFor: 'list' },
      type: 'SET_ONBOARD_STOP_CHOICE'
    })
    expect(otp.goMode.onboard.passedStops).toEqual([BEHIND])
    otp = reducer(otp, {
      payload: { keep: false },
      type: 'ANSWER_ONBOARD_STOP_CHOICE'
    })
    expect(otp.goMode.onboard.passedStops).toBeNull()
    expect(otp.goMode.onboard.stops).toEqual([])
  })
})
