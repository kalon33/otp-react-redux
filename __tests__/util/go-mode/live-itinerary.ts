import { buildLiveItinerary } from '../../../lib/util/go-mode/live-itinerary'
import type { LiveLegTime } from '../../../lib/actions/go-mode'

// 4:52 walk -> 5:00/5:30 bus -> 5:35 walk. Plain round numbers so a delay is
// obvious by inspection.
const SCHED_BOARD = 1700000000000
const SCHED_ALIGHT = SCHED_BOARD + 30 * 60 * 1000

const itinerary = (): any => ({
  duration: 2580,
  legs: [
    {
      endTime: SCHED_BOARD,
      mode: 'WALK',
      startTime: SCHED_BOARD - 8 * 60 * 1000
    },
    {
      arrivalDelay: 0,
      departureDelay: 0,
      endTime: SCHED_ALIGHT,
      // Real OTP legs always carry this (empty when there's no Fares V2 data).
      fareProducts: [],
      mode: 'BUS',
      realTime: false,
      routeShortName: '18',
      startTime: SCHED_BOARD,
      transitLeg: true
    },
    {
      endTime: SCHED_ALIGHT + 5 * 60 * 1000,
      mode: 'WALK',
      startTime: SCHED_ALIGHT
    }
  ]
})

describe('buildLiveItinerary', () => {
  it('folds a live board and alight into the transit leg with delays', () => {
    // Bus running 3 min late boarding, 5 min late arriving.
    const live: Record<number, LiveLegTime> = {
      1: {
        alightEpoch: SCHED_ALIGHT + 5 * 60 * 1000,
        alightRealtime: true,
        boardEpoch: SCHED_BOARD + 3 * 60 * 1000,
        boardRealtime: true,
        realtime: true
      }
    }
    const leg = buildLiveItinerary(itinerary(), live).legs[1] as any
    expect(leg.startTime).toBe(SCHED_BOARD + 3 * 60 * 1000)
    expect(leg.endTime).toBe(SCHED_ALIGHT + 5 * 60 * 1000)
    expect(leg.departureDelay).toBe(180)
    expect(leg.arrivalDelay).toBe(300)
    expect(leg.realTime).toBe(true)
  })

  it('applies only the field that is actually live', () => {
    // The common mid-ride case: a live alight prediction, but the board time
    // has already passed and only the schedule is known. The alight must not
    // drag the board time along, and the board must not claim to be realtime.
    const live: Record<number, LiveLegTime> = {
      1: {
        alightEpoch: SCHED_ALIGHT + 60 * 1000,
        alightRealtime: true,
        boardEpoch: null,
        boardRealtime: false,
        realtime: true
      }
    }
    const leg = buildLiveItinerary(itinerary(), live).legs[1] as any
    expect(leg.startTime).toBe(SCHED_BOARD)
    expect(leg.departureDelay).toBe(0)
    expect(leg.endTime).toBe(SCHED_ALIGHT + 60 * 1000)
    expect(leg.arrivalDelay).toBe(60)
  })

  it('does not style a schedule-fallback figure as live', () => {
    // alightRealtime false: the epoch exists but came from the schedule. The
    // leg-level `realtime` flag is an OR across board and alight and must not
    // be allowed to promote it.
    const live: Record<number, LiveLegTime> = {
      1: {
        alightEpoch: SCHED_ALIGHT,
        alightRealtime: false,
        boardEpoch: SCHED_BOARD,
        boardRealtime: false,
        realtime: true
      }
    }
    const leg = buildLiveItinerary(itinerary(), live).legs[1] as any
    expect(leg.realTime).toBe(false)
    expect(leg.startTime).toBe(SCHED_BOARD)
    expect(leg.endTime).toBe(SCHED_ALIGHT)
  })

  it('carries a late arrival into the walk that follows it', () => {
    // The itinerary shows the time of the leg STARTING at each place, so the
    // alight stop's time comes from the following walk leg. If that doesn't
    // move, a bus running 4 min late still reads as on time where it matters.
    const live: Record<number, LiveLegTime> = {
      1: {
        alightEpoch: SCHED_ALIGHT + 4 * 60 * 1000,
        alightRealtime: true,
        boardEpoch: null,
        realtime: true
      }
    }
    const legs = buildLiveItinerary(itinerary(), live).legs as any[]
    expect(legs[2].startTime).toBe(SCHED_ALIGHT + 4 * 60 * 1000)
    expect(legs[2].endTime).toBe(SCHED_ALIGHT + 9 * 60 * 1000)
    // The walk BEFORE the bus is untouched — it already happened.
    expect(legs[0].endTime).toBe(SCHED_BOARD)
  })

  it('does not shift a later bus by an earlier bus running late', () => {
    // A downstream bus departs when it departs; sliding its clock would be a
    // lie, and would make a missed connection look catchable.
    const twoBuses: any = itinerary()
    twoBuses.legs.push({
      arrivalDelay: 0,
      departureDelay: 0,
      endTime: SCHED_ALIGHT + 25 * 60 * 1000,
      mode: 'BUS',
      realTime: false,
      routeShortName: '21',
      startTime: SCHED_ALIGHT + 10 * 60 * 1000,
      transitLeg: true
    })
    const legs = buildLiveItinerary(twoBuses, {
      1: {
        alightEpoch: SCHED_ALIGHT + 4 * 60 * 1000,
        alightRealtime: true,
        boardEpoch: null,
        realtime: true
      }
    }).legs as any[]
    expect(legs[3].startTime).toBe(SCHED_ALIGHT + 10 * 60 * 1000)
    expect(legs[3].endTime).toBe(SCHED_ALIGHT + 25 * 60 * 1000)
  })

  it('leaves walk legs and legs with no live entry untouched', () => {
    const original = itinerary()
    const live = buildLiveItinerary(original, {})
    expect(live.legs).toEqual(original.legs)
  })

  it('normalizes fareProducts on transit legs', () => {
    // The fare table flatMaps fareProducts across transit legs and reads
    // `.product` off each entry: a MISSING array (Go Mode's synthesized
    // onboard bus leg) or a nullish entry crashes the whole sheet.
    const withBadFare: any = itinerary()
    delete withBadFare.legs[1].fareProducts
    const legs = buildLiveItinerary(withBadFare, {}).legs as any[]
    expect(legs[1].fareProducts).toEqual([])

    const withNullEntry: any = itinerary()
    withNullEntry.legs[1].fareProducts = [null, { id: 'a', product: {} }]
    const legs2 = buildLiveItinerary(withNullEntry, {}).legs as any[]
    expect(legs2[1].fareProducts).toEqual([{ id: 'a', product: {} }])
  })

  it('does not mutate the itinerary it was given', () => {
    const original = itinerary()
    buildLiveItinerary(original, {
      1: {
        alightEpoch: SCHED_ALIGHT + 60 * 1000,
        alightRealtime: true,
        boardEpoch: SCHED_BOARD + 60 * 1000,
        boardRealtime: true,
        realtime: true
      }
    })
    expect(original.legs[1].startTime).toBe(SCHED_BOARD)
    expect(original.legs[1].endTime).toBe(SCHED_ALIGHT)
  })

  it('never shows a leg arriving before it departs', () => {
    // Board and alight are applied independently, so a board time later than
    // the alight prediction inverts the leg (8/2: -114s, -175s, -268s). The
    // rider can't arrive early by boarding late — keep the planned run.
    const live: Record<number, LiveLegTime> = {
      1: {
        alightEpoch: SCHED_ALIGHT - 40 * 60 * 1000, // behind the board time
        alightRealtime: true,
        boardEpoch: SCHED_BOARD + 3 * 60 * 1000,
        boardRealtime: true,
        realtime: true
      }
    }
    const leg = buildLiveItinerary(itinerary(), live).legs[1] as any
    expect(leg.startTime).toBe(SCHED_BOARD + 3 * 60 * 1000)
    expect(leg.endTime).toBe(SCHED_BOARD + 33 * 60 * 1000)
    expect(leg.endTime).toBeGreaterThan(leg.startTime)
  })
})
