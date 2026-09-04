import {
  clampNonLiveLegTimes,
  getDownstreamStops,
  groupAlightOptionsByRoute,
  LIVE_TIME_CLAMP_GRANULARITY_MS,
  liveStopArrival,
  mergeLiveTimePoint,
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

/** Transit itinerary that departs at a given moment (reachability tests). */
const departing = (startTime: number, duration = 600) =>
  ({ ...transitItin(duration), startTime } as any)

const SERVICE_DAY = 1_700_000_000

/**
 * One stop of a trip, `dep` seconds into the service day. `live` gives it a
 * realtime arrival; `delay` shifts that arrival off the schedule.
 */
const stopTime = (
  id: string,
  dep: number,
  { delay = 0, live = false, serviceDay = SERVICE_DAY } = {}
) =>
  ({
    arrivalDelay: delay,
    realtimeArrival: live ? dep + delay : undefined,
    realtimeState: live ? 'UPDATED' : 'SCHEDULED',
    scheduledArrival: dep,
    scheduledDeparture: dep,
    serviceDay,
    stop: { id, lat: 44.97 + dep / 1e6, lon: -93.27, name: id }
  } as any)

const T0 = 1_700_000_000_000

describe('getDownstreamStops', () => {
  // Anchor on the vehicle's next stop so the tests do not depend on geometry.
  const stops = (sts: any[], nowMs: number) =>
    getDownstreamStops(
      { stopTimes: sts } as any,
      { nextStopId: sts[0].stop.id },
      null,
      { lat: 45.03, lon: -93.31 },
      nowMs
    )

  const NOW = SERVICE_DAY * 1000 + 69_480_000 // stop A's scheduled moment

  it('anchors the schedule fallback to now at the vehicle’s next stop', () => {
    const out = stops(
      [stopTime('A', 69480), stopTime('B', 69600), stopTime('C', 69720)],
      NOW
    )
    expect(out.map((s) => s.busArrivalEpoch)).toEqual([
      NOW,
      NOW + 120_000,
      NOW + 240_000
    ])
    expect(out.every((s) => s.realtime === false)).toBe(true)
  })

  it('keeps a live arrival that is merely earlier than schedule — the bus is running ahead', () => {
    const out = stops(
      [stopTime('A', 69480), stopTime('B', 69600, { delay: -60, live: true })],
      NOW
    )
    expect(out[1].busArrivalEpoch).toBe(NOW + 60_000)
    expect(out[1].realtime).toBe(true)
  })

  it('drops a live arrival that lands before the clock, and stops calling it live (8/9)', () => {
    // 1:53313's shape: UPDATED, delay 0, so its arrival is its scheduled time
    // — already 9 minutes gone by the time the app reads it.
    const out = stops(
      [stopTime('A', 69480), stopTime('B', 69600, { live: true })],
      NOW + 540_000
    )
    expect(out[1].busArrivalEpoch).toBeGreaterThanOrEqual(NOW + 540_000)
    expect(out[1].realtime).toBe(false)
  })

  it('drops a live arrival that lands before the stop ahead of it (8/9)', () => {
    // B is late and honest; C claims to be reached before B.
    const out = stops(
      [
        stopTime('A', 69480),
        stopTime('B', 69600, { delay: 660, live: true }),
        stopTime('C', 69720, { live: true })
      ],
      NOW
    )
    expect(out[2].busArrivalEpoch).toBeGreaterThanOrEqual(
      out[1].busArrivalEpoch
    )
    expect(out[2].realtime).toBe(false)
  })

  it('floors the schedule fallback to the last accepted arrival, so a late bus’s un-updated stops inherit the delay', () => {
    const out = stops(
      [
        stopTime('A', 69480),
        stopTime('B', 69600, { delay: 660, live: true }),
        stopTime('C', 69720)
      ],
      NOW
    )
    // Without the floor C would be re-anchored to an undelayed now + 240s and
    // land 7 minutes before the stop before it.
    expect(out[2].busArrivalEpoch).toBeGreaterThanOrEqual(
      out[1].busArrivalEpoch
    )
  })

  it('demotes only the poisoned stop — the live figures after it survive (8/9)', () => {
    const out = stops(
      [
        stopTime('A', 69480),
        stopTime('B', 69600, { live: true }),
        stopTime('C', 69660, { delay: 664, live: true })
      ],
      NOW + 540_000
    )
    expect(out[1].realtime).toBe(false)
    expect(out[2].realtime).toBe(true)
    expect(out[2].busArrivalEpoch).toBe((SERVICE_DAY + 69660 + 664) * 1000)
  })

  it('never returns a stop the bus reaches before the one ahead of it', () => {
    const out = stops(
      [
        stopTime('A', 69480),
        stopTime('B', 69600, { live: true }),
        stopTime('C', 69660, { delay: 664, live: true }),
        stopTime('D', 69780)
      ],
      NOW + 540_000
    )
    const epochs = out.map((s) => s.busArrivalEpoch)
    expect(epochs).toEqual([...epochs].sort((a, b) => a - b))
  })

  it('skips stops with no coordinates without advancing the arrival floor', () => {
    const blind = stopTime('B', 69600)
    blind.stop.lat = null
    const out = stops([stopTime('A', 69480), blind, stopTime('C', 69720)], NOW)
    expect(out.map((s) => s.stop.id)).toEqual(['A', 'C'])
    expect(out[1].busArrivalEpoch).toBe(NOW + 240_000)
  })
})

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

  it('drops an onward plan that departs before the rider is off the bus', () => {
    // The bus reaches the stop at T0+600s; this plan left 10 minutes earlier.
    const gone = candidate(T0 + 600_000, [departing(T0)], { stopId: 'A' })
    const ok = candidate(T0 + 600_000, [departing(T0 + 660_000)], {
      stopId: 'B'
    })
    expect(rankAlightOptions([gone, ok]).map((o) => o.stopId)).toEqual(['B'])
  })

  it('drops a plan that departed before now, whatever the bus arrival claims (8/9)', () => {
    // The shape of the 8/9 failure: busArrivalEpoch is itself a lie already
    // behind the clock, so the plan agrees with it and only `now` disputes it.
    const past = candidate(T0 - 540_000, [departing(T0 - 540_000)], {
      stopId: 'A'
    })
    expect(rankAlightOptions([past])).toHaveLength(1)
    expect(rankAlightOptions([past], { nowMs: T0 })).toEqual([])
  })

  it('keeps a plan departing inside the one-minute grace', () => {
    const late = candidate(T0 + 600_000, [departing(T0 + 540_001)], {
      stopId: 'A'
    })
    expect(rankAlightOptions([late], { nowMs: T0 })).toHaveLength(1)
  })

  it('keeps an itinerary with no startTime rather than dropping every option', () => {
    // OTP always sets startTime; its absence means synthetic data. Failing
    // closed here would empty the option list on any unexpected shape.
    expect(
      rankAlightOptions([candidate(T0, [transitItin(600)])], { nowMs: T0 })
    ).toHaveLength(1)
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

describe('mergeLiveTimePoint', () => {
  const NOW = 1783883000000 // 14:03:20 on the 7/12 ride

  it('accepts live data as-is, even moving earlier', () => {
    const prev = { epoch: NOW + 300000, realtime: true }
    const next = { epoch: NOW + 240000, realtime: true }
    expect(mergeLiveTimePoint(prev, next, NOW)).toEqual(next)
  })

  it('keeps the last live figure when realtime drops to schedule (7/12 case)', () => {
    // Live said 14:07:27; the prediction vanished and schedule says 14:01:00
    // (already past). The displayed time must not walk backwards.
    const prev = { epoch: 1783883247000, realtime: true }
    const next = { epoch: 1783882860000, realtime: false }
    const merged = mergeLiveTimePoint(prev, next, NOW)
    expect(merged).toEqual({ epoch: 1783883247000, realtime: false })
  })

  it('clamps a schedule-only value to now (a bus cannot arrive in the past)', () => {
    const next = { epoch: NOW - 120000, realtime: false }
    expect(mergeLiveTimePoint(null, next, NOW)).toEqual({
      epoch: NOW,
      realtime: false
    })
  })

  it('keeps a frozen last-known value across repeated schedule ticks', () => {
    const live = { epoch: NOW + 250000, realtime: true }
    const scheduled = { epoch: NOW - 140000, realtime: false }
    const tick1 = mergeLiveTimePoint(live, scheduled, NOW)
    const tick2 = mergeLiveTimePoint(tick1, scheduled, NOW + 20000)
    expect(tick2).toEqual({ epoch: NOW + 250000, realtime: false })
  })

  it('recovers to live when the prediction comes back', () => {
    const frozen = { epoch: NOW + 250000, realtime: false }
    const back = { epoch: NOW + 280000, realtime: true }
    expect(mergeLiveTimePoint(frozen, back, NOW)).toEqual(back)
  })

  it('keeps the previous value when no new data arrives', () => {
    const prev = { epoch: NOW + 250000, realtime: true }
    expect(mergeLiveTimePoint(prev, null, NOW)).toEqual({
      epoch: NOW + 250000,
      realtime: false
    })
  })

  it('returns null with nothing to merge', () => {
    expect(mergeLiveTimePoint(null, null, NOW)).toBeNull()
  })
})

describe('clampNonLiveLegTimes', () => {
  const NOW = 1784692936000 // 23:42:16 on the 7/21 end-of-service sample
  const entry = (over: any) => ({
    alightEpoch: NOW + 300000,
    alightRealtime: false,
    boardEpoch: NOW + 60000,
    boardRealtime: false,
    realtime: false,
    ...over
  })

  // The clamp's floor: 23:42:00. Raising to the minute rather than to the
  // second is the 2026-09-04 rate fix — nothing displays seconds, so a value
  // already inside the displayed minute is left where it is.
  const FLOOR = NOW - 16000

  it('raises a non-live alight epoch that fell out of the displayed minute (7/21 case)', () => {
    // 23:41:50 sampled at 23:42:16 — an end-of-service realtime dropout left
    // the alight time stale between 20 s refresh polls.
    const times = { 1: entry({ alightEpoch: NOW - 26000 }) }
    expect(clampNonLiveLegTimes(times, NOW)).toEqual({
      1: entry({ alightEpoch: FLOOR })
    })
  })

  it('leaves a drift the rider cannot see alone (2026-09-04 rate fix)', () => {
    // 23:42:10 at 23:42:16: six seconds stale, and it renders as 23:42 either
    // way. Raising it would cost a SET_LIVE_LEG_TIMES dispatch and change no
    // displayed value — 312 consecutive ticks did exactly that on the kerb
    // ride.
    expect(
      clampNonLiveLegTimes({ 1: entry({ alightEpoch: NOW - 6000 }) }, NOW)
    ).toBeNull()
  })

  it('clamps board and alight independently', () => {
    const times = {
      1: entry({ alightEpoch: NOW - 26000, boardEpoch: NOW - 29000 })
    }
    expect(clampNonLiveLegTimes(times, NOW)).toEqual({
      1: entry({
        alightEpoch: FLOOR,
        boardClamped: true,
        boardEpoch: FLOOR
      })
    })
  })

  it('bridges a departed board once, then leaves it where it is', () => {
    // 2026-09-04 11:17:30 -> 11:22:42: `boardEpoch` equal to the current
    // second on 312 consecutive ticks, `boardRealtime: false`, while the bus
    // that served the run had already gone (REALTIME_VEHICLE_POSITIONS
    // returned `vehicles: []` at 11:17:50). A departure is a one-way fact:
    // bridge the poll gap once, then let classifyMissedBus tell the story.
    let record: any = entry({
      alightEpoch: NOW + 300000,
      boardEpoch: NOW - 90000
    })
    let dispatches = 0
    for (let tick = 0; tick < 60; tick++) {
      const out = clampNonLiveLegTimes({ 1: record }, NOW + tick * 1000)
      if (out) {
        dispatches++
        record = out[1]
      }
    }
    expect(dispatches).toBe(1)
    expect(record.boardEpoch).toBe(FLOOR)
    expect(record.boardClamped).toBe(true)
  })

  it('dispatches once per displayed minute while a stale alight sits there', () => {
    // Same 60 ticks against the alight half. 23:42:16 -> 23:43:15 crosses
    // exactly one minute boundary, so the honest answer is two dispatches,
    // not the sixty the old clamp produced.
    let record: any = entry({ alightEpoch: NOW - 90000 })
    let dispatches = 0
    for (let tick = 0; tick < 60; tick++) {
      const out = clampNonLiveLegTimes({ 1: record }, NOW + tick * 1000)
      if (out) {
        dispatches++
        record = out[1]
      }
    }
    expect(dispatches).toBe(2)
    expect(record.alightEpoch).toBe(FLOOR + LIVE_TIME_CLAMP_GRANULARITY_MS)
    expect(LIVE_TIME_CLAMP_GRANULARITY_MS).toBe(60000)
  })

  it('leaves live figures alone even when past (a live time may lag honestly)', () => {
    const times = {
      1: entry({
        alightEpoch: NOW - 6000,
        alightRealtime: true,
        realtime: true
      })
    }
    expect(clampNonLiveLegTimes(times, NOW)).toBeNull()
  })

  it('falls back to the legacy any-field realtime flag', () => {
    const times = {
      1: entry({
        alightEpoch: NOW - 6000,
        alightRealtime: undefined,
        realtime: true
      })
    }
    expect(clampNonLiveLegTimes(times, NOW)).toBeNull()
  })

  it('returns null when nothing drifted, so callers skip the dispatch', () => {
    expect(clampNonLiveLegTimes({ 1: entry({}) }, NOW)).toBeNull()
    expect(clampNonLiveLegTimes(null, NOW)).toBeNull()
  })

  it('keeps untouched legs identical while clamping the stale one', () => {
    const fresh = entry({})
    const times = { 1: fresh, 2: entry({ alightEpoch: NOW - 26000 }) }
    const out = clampNonLiveLegTimes(times, NOW)
    expect(out?.[1]).toBe(fresh)
    expect(out?.[2].alightEpoch).toBe(FLOOR)
  })

  it('carries a schedule-only alight along when raising the board past it', () => {
    // 8/2: raising a non-live board time to now while the alight sat in the
    // past showed the rider arriving before they got on.
    const times = {
      1: entry({
        alightEpoch: NOW - 60000,
        alightRealtime: false,
        boardEpoch: NOW - 90000,
        boardRealtime: false
      })
    }
    const out = clampNonLiveLegTimes(times, NOW)
    expect(out?.[1].boardEpoch).toBe(FLOOR)
    expect(out?.[1].alightEpoch).toBe(FLOOR)
  })

  it('gives way at the BOARD when the alight is the feed’s own figure', () => {
    // Corrected 2026-09-01. This case used to raise the live alight to now as
    // well, which made the trip's live end slide with the wall clock: on ride
    // 1 the Orange Line's realtime alight sat in the past and was re-written
    // by every 20 s poll, while the schedule-only board was raised each 1 Hz
    // tick and dragged it along. timeRemaining printed exactly 400.0 s on
    // every tick and estimatedArrival could never arrive. The leg still may
    // not read backwards — but it is the board, not the feed, that moves.
    const times = {
      1: entry({
        alightEpoch: NOW - 60000,
        alightRealtime: true,
        boardEpoch: NOW - 90000,
        boardRealtime: false
      })
    }
    const out = clampNonLiveLegTimes(times, NOW)
    expect(out?.[1].alightEpoch).toBe(NOW - 60000)
    expect(out?.[1].boardEpoch).toBe(NOW - 60000)
    // ...and the tick after that dispatches nothing at all: the board is
    // handed straight back to where it already was, which on 2026-09-04 was
    // ten byte-identical SET_LIVE_LEG_TIMES in a row (11:22:29 -> 11:22:38).
    expect(clampNonLiveLegTimes({ 1: out![1] }, NOW + 1000)).toBeNull()
    expect(out?.[1].boardEpoch).toBeLessThanOrEqual(
      out?.[1].alightEpoch as number
    )
  })

  it('leaves a merely-late live pair alone — that is honest data', () => {
    expect(
      clampNonLiveLegTimes(
        {
          1: entry({
            alightEpoch: NOW - 6000,
            alightRealtime: true,
            boardEpoch: NOW - 60000,
            boardRealtime: true,
            realtime: true
          })
        },
        NOW
      )
    ).toBeNull()
  })
})

describe('liveStopArrival name fallback', () => {
  const stopTimes = [
    {
      realtimeArrival: 51000,
      realtimeState: 'UPDATED',
      scheduledArrival: 50900,
      scheduledDeparture: 50900,
      serviceDay: 1783771200,
      stop: {
        id: '1:17868',
        lat: 44.77,
        lon: -93.27,
        name: 'Burnsville Transit Station'
      }
    }
  ] as any[]

  it('matches the twin-feed stop by name when the id misses', () => {
    const hit = liveStopArrival(
      stopTimes,
      '2:31929',
      'Burnsville Transit Station'
    )
    expect(hit).toEqual({ epoch: (1783771200 + 51000) * 1000, realtime: true })
  })

  it('still returns null when neither id nor name matches', () => {
    expect(liveStopArrival(stopTimes, '2:31929', 'Somewhere Else')).toBeNull()
  })
})

describe('liveStopArrival projection for a schedule-only trip', () => {
  // A three-stop run, 5 minutes between stops, no realtime anywhere. The bus is
  // at stop B; the rider gets off at C. serviceDay is chosen so the timetable
  // moments sit in the PAST relative to `now` — i.e. the bus is running late,
  // which is exactly when the old absolute-epoch answer went wrong.
  const DAY = 1783771200
  const A = 36000 // 10:00:00 on the service day
  const B = 36300 // 10:05:00
  const C = 36600 // 10:10:00
  const NOW = (DAY + C) * 1000 + 240_000 // 10:14 — four minutes down on B->C

  const stopTimes = [
    {
      scheduledArrival: A,
      scheduledDeparture: A,
      serviceDay: DAY,
      stop: { id: 's:A', lat: 44.9, lon: -93.3, name: 'A' }
    },
    {
      scheduledArrival: B,
      scheduledDeparture: B,
      serviceDay: DAY,
      stop: { id: 's:B', lat: 44.95, lon: -93.28, name: 'B' }
    },
    {
      scheduledArrival: C,
      scheduledDeparture: C,
      serviceDay: DAY,
      stop: { id: 's:C', lat: 45.0, lon: -93.26, name: 'C' }
    }
  ] as any[]

  const anchor = { nextStopId: 's:B', nowMs: NOW, userPos: null }

  it('without an anchor, keeps the absolute timetable moment', () => {
    // Unchanged behaviour for a leg the rider has not boarded: "now" says
    // nothing about where that bus is.
    expect(liveStopArrival(stopTimes, 's:C', 'C')).toEqual({
      epoch: (DAY + C) * 1000,
      realtime: false
    })
  })

  it('projects a downstream stop forward from where the bus is', () => {
    // B -> C is 5 scheduled minutes, so from now the rider arrives in 5 minutes
    // — not at a 10:10 that passed four minutes ago.
    expect(liveStopArrival(stopTimes, 's:C', 'C', anchor)).toEqual({
      epoch: NOW + 300_000,
      projected: true,
      realtime: false
    })
  })

  it('never projects into the past, however late the bus is', () => {
    const veryLate = { ...anchor, nowMs: NOW + 3_600_000 }
    const hit = liveStopArrival(stopTimes, 's:C', 'C', veryLate)
    expect(hit!.epoch).toBeGreaterThan(veryLate.nowMs)
  })

  it('leaves a stop the bus has already passed on the timetable', () => {
    // A is behind the anchor. It really did happen in the past; projecting
    // would invent a future for something already done.
    expect(liveStopArrival(stopTimes, 's:A', 'A', anchor)).toEqual({
      epoch: (DAY + A) * 1000,
      realtime: false
    })
  })

  it('still prefers realtime over any projection', () => {
    const withLive = stopTimes.map((st, i) =>
      i === 2
        ? { ...st, realtimeArrival: C + 120, realtimeState: 'UPDATED' }
        : st
    )
    expect(liveStopArrival(withLive, 's:C', 'C', anchor)).toEqual({
      epoch: (DAY + C + 120) * 1000,
      realtime: true
    })
  })

  it('a fresh projection supersedes a stale one rather than being held back', () => {
    // "Never walk backwards" exists to stop a schedule fallback dragging a live
    // time into the past — not to freeze an estimate being recomputed each poll.
    const stale = { epoch: NOW + 300_000, projected: true, realtime: false }
    const fresher = { epoch: NOW + 120_000, projected: true, realtime: false }
    expect(mergeLiveTimePoint(stale, fresher, NOW)).toEqual(fresher)
  })
})

/**
 * Rider ask #44 (2026-08-27): "on the already on the bus search they aren't
 * stacked, just a list of the same routes." Five ranked options off one bus
 * are routinely the same route chain reached from five alight stops.
 */
describe('groupAlightOptionsByRoute', () => {
  const MIN = 60000
  const T = 1700000000000

  /** An onboard option whose DISPLAY itinerary rides `routes` in order. */
  const option = (
    stopName: string,
    routes: string[],
    { bikeAfter = 400, endTime = T + 30 * MIN, hopMeters = 5000 } = {}
  ) =>
    ({
      busArrivalEpoch: T,
      displayItinerary: {
        endTime,
        legs: [
          ...routes.map((routeId, i) => ({
            distance: i === routes.length - 1 ? hopMeters : 5000,
            mode: 'BUS',
            routeId,
            transitLeg: true
          })),
          { distance: bikeAfter, mode: 'BICYCLE', transitLeg: false }
        ],
        startTime: T
      },
      itinerary: { legs: [] },
      realtime: true,
      stopId: `s:${stopName}`,
      stopName
    } as any)

  it('folds same-route-chain options into one row, best-ranked first', () => {
    const groups = groupAlightOptionsByRoute([
      option('98th St', ['1:539', '1:465']),
      option('Nicollet', ['1:539', '1:465']),
      option('Burnsville', ['1:539', '1:465'])
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].option.stopName).toBe('98th St')
    expect(groups[0].variants.map((v: any) => v.stopName)).toEqual([
      '98th St',
      'Nicollet',
      'Burnsville'
    ])
  })

  it('keeps genuinely different route chains apart', () => {
    const groups = groupAlightOptionsByRoute([
      option('98th St', ['1:539', '1:465']),
      option('Mall', ['1:Orange']),
      option('Nicollet', ['1:539', '1:465'])
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g: any) => g.variants.length)).toEqual([2, 1])
  })

  // The empty signature is "no transit after the bus". Bike-from-98th and
  // bike-from-Nicollet share nothing but the absence of a route, so they must
  // not collapse — the same rule itinerariesAreEqual applies.
  it('never folds two bike-the-rest-of-the-way options together', () => {
    const groups = groupAlightOptionsByRoute([
      { ...option('98th St', []), displayItinerary: { endTime: T, legs: [] } },
      { ...option('Nicollet', []), displayItinerary: { endTime: T, legs: [] } }
    ] as any)
    expect(groups).toHaveLength(2)
  })

  // The 2026-08-31 602 m case, on the onboard path: a two-block hop that ends
  // in a 1743 m bike does not outrank the same journey without it.
  it('demotes a row whose last transit leg is a token hop', () => {
    const withHop = option('98th & Dupont', ['1:Orange', '1:539'], {
      bikeAfter: 1743,
      endTime: T + 30 * MIN,
      hopMeters: 602
    })
    const withoutHop = option('Mall', ['1:Orange'], {
      bikeAfter: 3970,
      endTime: T + 33 * MIN,
      hopMeters: 5000
    })
    const groups = groupAlightOptionsByRoute([withHop, withoutHop])
    expect(groups.map((g: any) => g.option.stopName)).toEqual([
      'Mall',
      '98th & Dupont'
    ])
  })

  it('leaves the token hop alone when nothing replaces it', () => {
    const withHop = option('98th & Dupont', ['1:Orange', '1:539'], {
      bikeAfter: 1743,
      hopMeters: 602
    })
    const other = option('Mall', ['1:465'])
    const groups = groupAlightOptionsByRoute([withHop, other])
    expect(groups.map((g: any) => g.option.stopName)).toEqual([
      '98th & Dupont',
      'Mall'
    ])
  })

  it('survives an empty or absent list', () => {
    expect(groupAlightOptionsByRoute([])).toEqual([])
    expect(groupAlightOptionsByRoute(null)).toEqual([])
  })
})
