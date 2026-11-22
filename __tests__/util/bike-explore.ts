import {
  applyExploreVariants,
  buildExploreRequest,
  exploreAccessItinerary,
  exploreDirectLeaveMs,
  exploreItineraryKey,
  exploreMarginMs,
  ExploreResult,
  exploreRideOf,
  exploreTargetOf,
  fetchBikeExplore,
  nicestExploreIndex,
  normalizeExploreMode,
  otpRowOf,
  pickBestExploreResult,
  stressCategory,
  stressShares,
  stressStripSegments
} from '../../lib/util/bike-explore'
import engine from '../test-utils/mock-data/bike-explore-0923-1537.json'
import recorded from '../test-utils/mock-data/other-stops-0923-1537.json'
import searchResponses from '../test-utils/mock-data/0921-0912-search-responses.json'

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

  it('inflates a compact answer to the flat shape, sharing the heavy fields', async () => {
    const ride = {
      calm: 0.9,
      direct: { calm: 0.5, distance_m: 900, duration_s: 200 },
      duration_s: 240,
      leg: { distance: 1000 },
      stress_profile: [[10, 1]]
    }
    const compact = {
      candidates: [
        {
          direct_leave_in_s: 77,
          feasible: true,
          id: 'a',
          leave_in_s: 5,
          ride: 0
        },
        { feasible: true, id: 'b', leave_in_s: 9, ride: 0 },
        { feasible: false, id: 'c', reason: 'unroutable' },
        { feasible: true, id: 'd', reason: 'at the stop' }
      ],
      mode: 'calm',
      rides: [ride],
      status: 'ok'
    }
    const answer = await fetchBikeExplore(
      '/x',
      { a: 1 },
      {
        fetchImpl: (async () => ({
          json: async () => compact,
          ok: true
        })) as any
      }
    )
    const [a, b, c, d] = answer?.candidates as any[]
    expect(a).toEqual({
      ...ride,
      direct: { ...ride.direct, leave_in_s: 77 },
      feasible: true,
      id: 'a',
      leave_in_s: 5
    })
    expect(a.ride).toBeUndefined()
    expect(a.direct_leave_in_s).toBeUndefined()
    expect(b.direct.leave_in_s).toBeNull()
    expect(a.leg).toBe(ride.leg)
    expect(b.leg).toBe(ride.leg)
    expect(c).toBe(compact.candidates[2])
    expect(d).toBe(compact.candidates[3])
  })

  it('asks for a compact answer, up to 2000 candidates', () => {
    const candidates = Array.from({ length: 2100 }, (_, i) => ({
      busEpoch: NOW,
      id: `c${i}`,
      lat: 44.9,
      lon: -93.2
    }))
    const body = buildExploreRequest({
      candidates,
      compact: true,
      mode: 'calm',
      nowMs: NOW,
      origin
    })
    expect(body.compact).toBe(true)
    expect(body.candidates).toHaveLength(2000)
    expect(
      buildExploreRequest({ candidates, mode: 'calm', nowMs: NOW, origin })
        .compact
    ).toBeUndefined()
  })
})

/*
 * Backlog 76.2: the pure pieces the results list stands on. Real shapes:
 * the 09-23 15:37 Orange Line representative (bike -> 98th St -> 66th St ->
 * bike), the 09-21 09:12 search's bike-only and walk itineraries, and the
 * engine's own answers for that origin (bike-explore-0923-1537.json).
 */
const rec = recorded as any
const eng = engine as any
const search = searchResponses as any
const rep = () => JSON.parse(JSON.stringify(rec.representative))
const bikeOnly = () => JSON.parse(JSON.stringify(search['1'].itineraries[0]))
const walkTransit = () => JSON.parse(JSON.stringify(search['0'].itineraries[2]))

describe('util > bike-explore > which itineraries the engine is asked about', () => {
  it('a bike leg into the first bus, or a bike-only trip; nothing else', () => {
    expect(exploreTargetOf(rep())).toBe('access')
    expect(exploreTargetOf(bikeOnly())).toBe('bike-only')
    expect(exploreTargetOf(walkTransit())).toBeNull()
    const rented = rep()
    rented.legs[0].rentedBike = true
    expect(exploreTargetOf(rented)).toBeNull()
    // Bike, then a walk to the platform: not the shape OTP gives a carried
    // bike, and not one the splice handles.
    const walkBetween = rep()
    walkBetween.legs.splice(1, 0, { ...walkBetween.legs[0], mode: 'WALK' })
    expect(exploreTargetOf(walkBetween)).toBeNull()
    expect(exploreTargetOf(null)).toBeNull()
  })

  it('names an itinerary by its legs, not by where it sits in the list', () => {
    const a = rep()
    const key = exploreItineraryKey(a)
    expect(exploreItineraryKey({ ...rep(), index: 7 })).toBe(key)
    expect(key).toContain('BUS:')
    expect(key).toContain('1:56831')
    const later = rep()
    later.legs[1].startTime += 600000
    expect(exploreItineraryKey(later)).not.toBe(key)
    expect(exploreItineraryKey(bikeOnly())).toMatch(/^BICYCLE:/)
  })
})

describe('util > bike-explore > the list as shown', () => {
  const variantOf = (itin: any) => ({
    ...itin,
    legs: [
      { ...itin.legs[0], exploreRide: { score: 80 } },
      ...itin.legs.slice(1)
    ]
  })

  it('Direct, or nothing stored, is the very same array', () => {
    const list = [
      { ...rep(), index: 0 },
      { ...walkTransit(), index: 1 }
    ]
    const entries = {
      [exploreItineraryKey(list[0])]: {
        status: 'done' as const,
        variant: variantOf(list[0])
      }
    }
    expect(applyExploreVariants(list, 'direct', entries)).toBe(list)
    expect(applyExploreVariants(list, 'calm', undefined)).toBe(list)
    expect(applyExploreVariants(list, 'calm', {})).toBe(list)
    expect(
      applyExploreVariants(list, 'calm', {
        [exploreItineraryKey(list[0])]: { status: 'none' }
      })
    ).toBe(list)
  })

  it("puts a variant at its itinerary's position, index kept", () => {
    const list = [
      { ...walkTransit(), index: 0 },
      { ...rep(), index: 1 }
    ]
    const variant = variantOf(rep())
    const shown = applyExploreVariants(
      list,
      'wander',
      { [exploreItineraryKey(list[1])]: { status: 'done', variant } },
      (itin) => ({ ...itin, finished: true })
    )
    expect(shown).not.toBe(list)
    expect(shown[0]).toBe(list[0])
    expect(shown[1].index).toBe(1)
    expect((shown[1] as any).finished).toBe(true)
    expect(exploreRideOf(shown[1])?.score).toBe(80)
  })

  it("puts a row's explore rides back to OTP's for the lookups that build from it", () => {
    const otp = [
      { ...rep(), index: 0 },
      { ...rep(), index: 1 }
    ]
    otp[1].legs[1].startTime += 600000
    const v0 = { ...variantOf(otp[0]), index: 0 }
    const v1 = { ...variantOf(otp[1]), index: 1 }
    const row = {
      ...v0,
      allStartTimes: [
        { itinerary: v0, legs: v0.legs, realtime: false },
        { itinerary: v1, legs: v1.legs, realtime: false }
      ],
      sameShapeVariants: [v0, v1]
    }
    const back: any = otpRowOf(row, otp)
    expect(exploreRideOf(back)).toBeNull()
    expect(back.legs).toBe(otp[0].legs)
    expect(back.sameShapeVariants).toEqual([otp[0], otp[1]])
    expect(back.allStartTimes[1].itinerary).toBe(otp[1])
    expect(back.allStartTimes[1].legs).toBe(otp[1].legs)
    // A Direct row is handed back untouched.
    const direct = { ...otp[0], sameShapeVariants: [otp[0]] }
    expect(otpRowOf(direct, otp)).toBe(direct)
  })
})

describe('util > bike-explore > "nicest ride" among the earliest arrivals', () => {
  const withRide = (itin: any, index: number, score: number) => ({
    ...itin,
    index,
    legs: [{ ...itin.legs[0], exploreRide: { score } }, ...itin.legs.slice(1)]
  })

  it('marks the best-scored ride among those arriving in the earliest minute', () => {
    const a = withRide(rep(), 0, 70)
    const b = withRide(rep(), 1, 88)
    const late = withRide(rep(), 2, 99)
    late.endTime += 60000
    expect(nicestExploreIndex([a, b, late])).toBe(1)
  })

  it('says nothing with one option that early, or no explore ride among them', () => {
    const a = withRide(rep(), 0, 70)
    const late = withRide(rep(), 1, 99)
    late.endTime += 120000
    expect(nicestExploreIndex([a, late])).toBeNull()
    const plain = [
      { ...rep(), index: 0 },
      { ...rep(), index: 1 }
    ]
    expect(nicestExploreIndex(plain)).toBeNull()
    expect(nicestExploreIndex([])).toBeNull()
    expect(nicestExploreIndex(null)).toBeNull()
  })
})

describe('util > bike-explore > the stress strip', () => {
  it('maps engine levels to four categories', () => {
    expect([0, 1, 2, 3, 4].map(stressCategory)).toEqual([
      'walk',
      'calm',
      'calm',
      'busy',
      'heavy'
    ])
  })

  it('joins neighbours of a real profile and sizes them by metres', () => {
    // The engine's 15:37 Wander ride to Burnsville Pkwy: 14 stretches.
    const profile = eng.access.wander.candidates.find(
      (c: any) => c.id === '1:56829'
    ).stress_profile
    expect(profile.length).toBe(14)
    const segments = stressStripSegments(profile)
    expect(segments.length).toBeLessThanOrEqual(profile.length)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].category).not.toBe(segments[i - 1].category)
    }
    const metres = profile.reduce((sum: number, p: any) => sum + p[0], 0)
    expect(segments.reduce((sum, s) => sum + s.metres, 0)).toBeCloseTo(metres)
    expect(segments.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1)
    const shares = stressShares(segments)
    expect(shares.calm + shares.busy + shares.heavy + shares.walk).toBeCloseTo(
      1
    )
  })

  it('drops empty or malformed stretches', () => {
    expect(stressStripSegments(null)).toEqual([])
    expect(stressStripSegments([[0, 1]] as any)).toEqual([])
    expect(
      stressStripSegments([
        [100, 1],
        [NaN, 3],
        [100, 2],
        [50, 0]
      ] as any)
    ).toEqual([
      { category: 'calm', metres: 200, share: 0.8 },
      { category: 'walk', metres: 50, share: 0.2 }
    ])
  })
})

describe("util > bike-explore > the direct ride's leave-by time", () => {
  it('is the bus less the margin of the DIRECT ride, less that ride', () => {
    const bus = rec.representative.legs[1].startTime
    const itin = rep()
    itin.legs[0].exploreRide = { directDurationS: 412 }
    expect(exploreDirectLeaveMs(itin)).toBe(
      bus - exploreMarginMs(412000) - 412000
    )
  })

  it('has none without a bus or a direct time', () => {
    const only = bikeOnly()
    only.legs[0].exploreRide = { directDurationS: 3320 }
    expect(exploreDirectLeaveMs(only)).toBeNull()
    const itin = rep()
    itin.legs[0].exploreRide = { directDurationS: null }
    expect(exploreDirectLeaveMs(itin)).toBeNull()
    expect(exploreDirectLeaveMs(rep())).toBeNull()
  })
})
