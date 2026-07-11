import {
  pickBestAlightOption,
  pickTripServiceInstance,
  rankAlightOptions,
  scoreAlightOption
} from '../../../lib/util/go-mode/alight-optimizer'

/** Minimal itinerary with a transit leg. */
const transitItin = (
  duration: number,
  { transfers = 0, walkDistance = 100 } = {}
) =>
  ({
    duration,
    legs: [
      { mode: 'WALK', transitLeg: false },
      { mode: 'BUS', transitLeg: true }
    ],
    transfers,
    walkDistance
  } as any)

/** Walk-only itinerary (no transit leg) of a given walk distance. */
const walkItin = (duration: number, walkDistance: number) =>
  ({
    duration,
    legs: [{ mode: 'WALK', transitLeg: false }],
    transfers: 0,
    walkDistance
  } as any)

const candidate = (
  busArrivalEpoch: number,
  itineraries: any[],
  extra: { error?: boolean; stopId?: string; stopName?: string } = {}
) => ({
  busArrivalEpoch,
  error: extra.error ?? false,
  itineraries,
  realtime: false,
  stopId: extra.stopId ?? 's',
  stopName: extra.stopName ?? 'Stop'
})

const T0 = 1_700_000_000_000

describe('pickBestAlightOption', () => {
  it('returns null when there are no candidates', () => {
    expect(pickBestAlightOption([])).toBeNull()
  })

  it('returns null when no candidate has a usable itinerary', () => {
    expect(
      pickBestAlightOption([candidate(T0, []), candidate(T0, [])])
    ).toBeNull()
  })

  it('skips errored candidates', () => {
    const best = pickBestAlightOption([
      candidate(T0, [transitItin(600)], { error: true, stopId: 'bad' }),
      candidate(T0, [transitItin(900)], { stopId: 'good' })
    ])
    expect(best?.stopId).toBe('good')
  })

  it('picks the earliest total arrival (bus arrival + onward duration)', () => {
    // A: arrives later but very short onward; B: arrives sooner but long onward.
    const a = candidate(T0 + 300_000, [transitItin(120)], { stopId: 'A' }) // total +420s
    const b = candidate(T0, [transitItin(1800)], { stopId: 'B' }) // total +1800s
    const best = pickBestAlightOption([a, b])
    expect(best?.stopId).toBe('A')
    expect(best?.busArrivalEpoch).toBe(T0 + 300_000)
  })

  it('within the tie window prefers fewer onward transfers', () => {
    // Both arrive within TIE_MS (180s) of each other; B has fewer transfers.
    const a = candidate(T0, [transitItin(600, { transfers: 2 })], {
      stopId: 'A'
    })
    const b = candidate(T0 + 60_000, [transitItin(600, { transfers: 0 })], {
      stopId: 'B'
    })
    const best = pickBestAlightOption([a, b])
    expect(best?.stopId).toBe('B')
  })

  it('drops a walk-the-whole-way fallback but keeps a short final walk', () => {
    // Long walk-only is rejected; the only usable plan is the short walk.
    const farWalk = candidate(T0, [walkItin(5000, 6000)], { stopId: 'far' })
    const shortWalk = candidate(T0 + 600_000, [walkItin(300, 250)], {
      stopId: 'near'
    })
    const best = pickBestAlightOption([farWalk, shortWalk], {
      walkOnlyMax: 1200
    })
    expect(best?.stopId).toBe('near')
  })

  it('chooses the quickest onward itinerary offered for a stop', () => {
    const best = pickBestAlightOption([
      candidate(T0, [transitItin(1800), transitItin(600)], { stopId: 'A' })
    ])
    expect(best?.itinerary.duration).toBe(600)
  })
})

describe('rankAlightOptions', () => {
  it('returns an empty list when no candidate is usable', () => {
    expect(rankAlightOptions([])).toEqual([])
    expect(rankAlightOptions([candidate(T0, []), candidate(T0, [])])).toEqual(
      []
    )
  })

  it('ranks options across stops by earliest total arrival', () => {
    // Distinct stops so the journeys are not deduped.
    const a = candidate(T0 + 300_000, [transitItin(120)], { stopId: 'A' }) // +420s
    const b = candidate(T0, [transitItin(1800)], { stopId: 'B' }) // +1800s
    const c = candidate(T0, [transitItin(300)], { stopId: 'C' }) // +300s
    const ranked = rankAlightOptions([a, b, c])
    expect(ranked.map((o) => o.stopId)).toEqual(['C', 'A', 'B'])
  })

  it('within the tie window ranks fewer transfers higher', () => {
    const a = candidate(T0, [transitItin(600, { transfers: 2 })], {
      stopId: 'A'
    })
    const b = candidate(T0 + 60_000, [transitItin(600, { transfers: 0 })], {
      stopId: 'B'
    })
    expect(rankAlightOptions([a, b])[0].stopId).toBe('B')
  })

  it('dedups identical journeys from the same stop', () => {
    // Two itineraries from stop A with the same leg signature collapse to one.
    const ranked = rankAlightOptions([
      candidate(T0, [transitItin(1800), transitItin(600)], { stopId: 'A' })
    ])
    expect(ranked).toHaveLength(1)
    expect(ranked[0].itinerary.duration).toBe(600)
  })

  it('respects the limit', () => {
    const cands = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((s, i) =>
      candidate(T0 + i * 60_000, [transitItin(300)], { stopId: s })
    )
    expect(rankAlightOptions(cands, { limit: 3 })).toHaveLength(3)
  })

  it('[0] matches pickBestAlightOption', () => {
    const a = candidate(T0 + 300_000, [transitItin(120)], { stopId: 'A' })
    const b = candidate(T0, [transitItin(1800)], { stopId: 'B' })
    const best = pickBestAlightOption([a, b])
    expect(rankAlightOptions([a, b])[0].stopId).toBe(best?.stopId)
  })
})

describe('pickTripServiceInstance', () => {
  // Service-day epochs (seconds): "yesterday" and "today", one day apart.
  const DAY = 86_400
  const SD_YDAY = 1_700_000_000
  const SD_TODAY = SD_YDAY + DAY
  /** Instance of a run: serviceDay + start (sec-of-day), 3 stops 10 min apart. */
  const instance = (serviceDay: number, startSec: number, live = false) =>
    [0, 600, 1200].map((off, i) => ({
      realtimeArrival: live ? startSec + off + 30 : undefined,
      realtimeState: live ? 'UPDATED' : 'SCHEDULED',
      scheduledArrival: startSec + off,
      scheduledDeparture: startSec + off,
      serviceDay,
      stop: { id: `1:s${i}`, lat: 0, lon: 0, name: `S${i}` }
    })) as any

  it('returns [] when no instance is usable', () => {
    expect(pickTripServiceInstance([], 0)).toEqual([])
    expect(pickTripServiceInstance([null, undefined], 0)).toEqual([])
    // dateless stoptimes (serviceDay -1) are unusable
    expect(pickTripServiceInstance([instance(-1, 600)], 0)).toEqual([])
  })

  it('prefers the instance with live realtime', () => {
    // Rider just after midnight: yesterday's 24h+ run is live, today's
    // morning run is schedule-only.
    const now = (SD_TODAY + 900) * 1000
    const yday = instance(SD_YDAY, DAY + 600, true) // 00:10 today, live
    const today = instance(SD_TODAY, 37_000) // 10:16 today, scheduled
    expect(pickTripServiceInstance([today, yday], now)).toBe(yday)
  })

  it('falls back to the instance whose window is nearest now', () => {
    const now = (SD_TODAY + 900) * 1000 // 00:15 today
    const yday = instance(SD_YDAY, DAY + 600) // spans 00:10-00:30 today
    const today = instance(SD_TODAY, 37_000) // 10-hour-away morning run
    expect(pickTripServiceInstance([today, yday], now)).toBe(yday)
  })

  it('keeps a single usable instance', () => {
    const today = instance(SD_TODAY, 37_000)
    expect(pickTripServiceInstance([today, null], 0)).toBe(today)
  })
})

describe('scoreAlightOption', () => {
  it('adds onward duration (seconds) to the bus arrival epoch (ms)', () => {
    expect(scoreAlightOption(T0, transitItin(600))).toBe(T0 + 600_000)
  })
})
