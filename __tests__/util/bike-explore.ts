import {
  buildExploreRequest,
  exploreAccessItinerary,
  exploreMarginMs,
  ExploreResult,
  exploreRideOf,
  fetchBikeExplore,
  normalizeExploreMode,
  pickBestExploreResult
} from '../../lib/util/bike-explore'

const NOW = 1795000000000
const origin = { lat: 44.9145, lon: -93.299 }

function result(over: Partial<ExploreResult> = {}): ExploreResult {
  return {
    calm: 0.98,
    direct: { calm: 0.6, distance_m: 2560, duration_s: 540, leave_in_s: 1000 },
    distance_m: 5170,
    duration_s: 1080,
    feasible: true,
    id: 'S1',
    leave_in_s: 420,
    leg: {
      distance: 5170,
      duration: 1080,
      legGeometry: { length: 3, points: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
      mode: 'BICYCLE',
      steps: [{ relativeDirection: 'DEPART', streetName: 'Bryant Ave S' }]
    },
    margin_s: 288,
    places: ['Minnehaha Creek'],
    preference: 1,
    score: 87,
    stress_profile: [[5170, 1]],
    summary: '100% calm · via Minnehaha Creek Park',
    via: 'Minnehaha Creek Park',
    ...over
  }
}

describe('util > bike-explore', () => {
  it('reads a stored mode, defaulting to the old routing', () => {
    expect(normalizeExploreMode('calm')).toBe('calm')
    expect(normalizeExploreMode('wander')).toBe('wander')
    expect(normalizeExploreMode('direct')).toBe('direct')
    expect(normalizeExploreMode(undefined)).toBe('direct')
    expect(normalizeExploreMode('scenic')).toBe('direct')
  })

  it('keeps 3 min plus a tenth of the ride at the stop', () => {
    expect(exploreMarginMs(600000)).toBe(240000)
    expect(exploreMarginMs(0)).toBe(180000)
    expect(exploreMarginMs(NaN)).toBe(180000)
  })

  it('asks nothing in direct mode or without candidates', () => {
    const candidates = [
      { busEpoch: NOW + 1800000, id: 'S1', lat: 44.92, lon: -93.27 }
    ]
    expect(
      buildExploreRequest({ candidates, mode: 'direct', nowMs: NOW, origin })
    ).toBeNull()
    expect(
      buildExploreRequest({ candidates: [], mode: 'calm', nowMs: NOW, origin })
    ).toBeNull()
    expect(
      buildExploreRequest({
        candidates,
        mode: 'calm',
        nowMs: NOW,
        origin: { lat: NaN, lon: 0 }
      })
    ).toBeNull()
  })

  it('states each bus as seconds from the moment the ride can start', () => {
    const body = buildExploreRequest({
      candidates: [
        {
          busEpoch: NOW + 1800000,
          id: 'S1',
          lat: 44.92,
          lon: -93.27,
          name: '46th St'
        },
        { busEpoch: null, id: 'DEST', lat: 44.9, lon: -93.3 }
      ],
      maxExtraS: 300,
      mode: 'wander',
      nowMs: NOW,
      origin,
      speed: 20
    })
    expect(body).toEqual({
      candidates: [
        { depart_s: 1800, id: 'S1', lat: 44.92, lon: -93.27, name: '46th St' },
        { depart_s: null, id: 'DEST', lat: 44.9, lon: -93.3, name: '' }
      ],
      lat: origin.lat,
      lon: origin.lon,
      max_extra_s: 300,
      mode: 'wander',
      speed: 12
    })
  })

  it('boards at the best-scoring feasible stop, the shorter ride on a near tie', () => {
    const a = result({ duration_s: 1080, id: 'A', score: 87 })
    const b = result({ duration_s: 600, id: 'B', score: 86 })
    const c = result({ duration_s: 300, id: 'C', score: 70 })
    const missed = result({ feasible: false, id: 'D', score: 99 })
    expect(pickBestExploreResult([a, b, c, missed])?.id).toBe('B')
    expect(pickBestExploreResult([c, a])?.id).toBe('A')
    expect(pickBestExploreResult([missed])).toBeNull()
    expect(pickBestExploreResult(null)).toBeNull()
  })

  it('times the ride to end one margin before the bus', () => {
    const bus = NOW + 1800000
    const access = exploreAccessItinerary({
      busEpoch: bus,
      from: { ...origin, name: 'Home' },
      mode: 'wander',
      result: result(),
      to: { lat: 44.92, lon: -93.27, name: '46th St' }
    })
    const leg: any = access?.legs[0]
    expect(leg.mode).toBe('BICYCLE')
    expect(leg.transitLeg).toBe(false)
    expect(leg.endTime).toBe(bus - exploreMarginMs(1080000))
    expect(leg.endTime - leg.startTime).toBe(1080000)
    expect(access?.startTime).toBe(leg.startTime)
    expect(leg.steps).toHaveLength(1)
    expect(leg.exploreRide).toMatchObject({
      calm: 0.98,
      directCalm: 0.6,
      directDurationS: 540,
      mode: 'wander',
      stopId: 'S1',
      via: 'Minnehaha Creek Park'
    })
    expect(exploreRideOf(access)?.score).toBe(87)
    expect(exploreRideOf({ legs: [{ mode: 'BICYCLE' }] } as any)).toBeNull()
  })

  it('starts a moving rider now rather than at the leave-by time', () => {
    const access = exploreAccessItinerary({
      busEpoch: NOW + 1800000,
      from: origin,
      mode: 'calm',
      result: result(),
      startMs: NOW,
      to: { lat: 44.92, lon: -93.27 }
    })
    expect(access?.startTime).toBe(NOW)
    expect(access?.endTime).toBe(NOW + 1080000)
  })

  it('gives no itinerary for an answer with no leg or no time to hang it on', () => {
    const base = { from: origin, mode: 'calm' as const, to: origin }
    expect(
      exploreAccessItinerary({
        ...base,
        busEpoch: NOW,
        result: result({ leg: undefined })
      })
    ).toBeNull()
    expect(
      exploreAccessItinerary({ ...base, busEpoch: null, result: result() })
    ).toBeNull()
  })

  it('never throws: a failed, refused or malformed answer is null', async () => {
    const ok = { candidates: [result()], mode: 'calm', status: 'ok' }
    const respond = (status: number, json: any) =>
      (async () => ({ json: async () => json, ok: status < 400 })) as any
    expect(
      await fetchBikeExplore('/x', { a: 1 }, { fetchImpl: respond(200, ok) })
    ).toEqual(ok)
    expect(
      await fetchBikeExplore('/x', { a: 1 }, { fetchImpl: respond(503, {}) })
    ).toBeNull()
    expect(
      await fetchBikeExplore(
        '/x',
        { a: 1 },
        { fetchImpl: respond(200, { status: 'preparing' }) }
      )
    ).toBeNull()
    const boom = (async () => {
      throw new Error('offline')
    }) as any
    expect(
      await fetchBikeExplore('/x', { a: 1 }, { fetchImpl: boom })
    ).toBeNull()
    expect(await fetchBikeExplore('/x', null)).toBeNull()
  })
})
