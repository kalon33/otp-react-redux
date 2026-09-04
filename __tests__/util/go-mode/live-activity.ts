import {
  __resetLiveActivity,
  buildLiveActivityContent,
  LIVE_ACTIVITY_UPDATE_INTERVAL_MS,
  liveActivityIsRunning,
  liveActivityUpdateDue,
  stopLiveActivity,
  syncLiveActivity
} from '../../../lib/util/go-mode/live-activity'
import {
  hasNativeLiveActivity,
  LiveActivityPayload,
  startLiveActivity,
  updateLiveActivity
} from '../../../lib/util/go-mode/native-live-activity'

/**
 * The Go Mode lock-screen Live Activity — backlog 8.10, the rider's ask of
 * 2026-09-01 08:28: *"an active widget that stays on lock screen when in go
 * mode? Showing next leg and arrival time?"*
 *
 * Three things are tested here because three things can silently break it:
 *
 *  1. THE ARRIVAL NUMBER. It must be the ITINERARY's end, not the current
 *     leg's. On 2026-09-01 08:26:27 the aboard re-plan announced 8:45 AM — the
 *     moment the rider got OFF the bus, read off `legs[0]` — while the
 *     itinerary it had just installed ended at 08:51:45. The fixture below is
 *     that shape deliberately, and the assertions name both numbers.
 *  2. THE BRIDGE. No npm dependency, so "is the plugin there" is answered by
 *     the injected `window.Capacitor` alone. A browser, an Android phone and
 *     an iOS shell built before the plugin landed must all be silent no-ops —
 *     that capability check is what makes an OTA carrying this safe to serve
 *     to the shell already on the rider's phone.
 *  3. THE THROTTLE. ActivityKit rate-limits updates per app and drops the
 *     excess with no error, so a per-GPS-tick cadence would work for the first
 *     mile and then stop working for the rest of the ride, invisibly.
 */

// --- fixture ---------------------------------------------------------------
// WALK to the stop -> route 6 -> WALK to the door. Three legs on purpose: the
// defect this feature must not repeat is quoting leg 0's end as the arrival.
const T = (mins: number) => Date.UTC(2026, 8, 1, 13, 0, 0) + mins * 60000

const WALK_TO_STOP_END = T(10)
const BUS_BOARD = T(12)
const BUS_ALIGHT = T(38)
const ITINERARY_END = T(45)

function itinerary(): any {
  return {
    endTime: ITINERARY_END,
    legs: [
      {
        endTime: WALK_TO_STOP_END,
        from: { name: 'Home' },
        mode: 'WALK',
        startTime: T(0),
        to: { name: 'Nicollet Ave & 5th St' }
      },
      {
        endTime: BUS_ALIGHT,
        fareProducts: [],
        from: { name: 'Nicollet Ave & 5th St', stop: { gtfsId: '1:100' } },
        mode: 'BUS',
        routeShortName: '6',
        startTime: BUS_BOARD,
        to: { name: 'Lake St & Hennepin' },
        transitLeg: true
      },
      {
        endTime: ITINERARY_END,
        from: { name: 'Lake St & Hennepin' },
        mode: 'WALK',
        startTime: BUS_ALIGHT,
        to: { name: 'Office' }
      }
    ],
    startTime: T(0)
  }
}

const baseInput = (over: any = {}) => ({
  activeItinerary: itinerary(),
  arrivedAt: null,
  departureOverride: null,
  liveLegTimes: {},
  progress: { currentLegIndex: 0 } as any,
  riding: null,
  tripId: 'ga-1',
  ...over
})

// --- bridge doubles --------------------------------------------------------
let plugin: {
  end: jest.Mock
  start: jest.Mock
  update: jest.Mock
}

function installBridge(
  options: { available?: boolean; native?: boolean } = {}
): void {
  plugin = {
    end: jest.fn().mockResolvedValue({ ended: true }),
    start: jest.fn().mockResolvedValue({ id: 'a1', started: true }),
    update: jest.fn().mockResolvedValue({ updated: true })
  }
  ;(window as any).Capacitor = {
    isNativePlatform: () => options.native !== false,
    isPluginAvailable: () => options.available !== false,
    Plugins: { LiveActivity: plugin }
  }
}

beforeEach(() => {
  __resetLiveActivity()
  delete (window as any).Capacitor
})

afterEach(() => {
  delete (window as any).Capacitor
})

describe('the bridge — a shell without the plugin is a no-op', () => {
  it('reports absent in a plain browser (no Capacitor at all)', async () => {
    expect(hasNativeLiveActivity()).toBe(false)
    expect(await startLiveActivity({} as LiveActivityPayload)).toBe(false)
    expect(await updateLiveActivity({} as LiveActivityPayload)).toBe(false)
  })

  it('reports absent when Capacitor is present but the platform is web', () => {
    installBridge({ native: false })
    expect(hasNativeLiveActivity()).toBe(false)
  })

  it('reports absent in a shell built BEFORE the plugin landed', () => {
    // isPluginAvailable answers for the native side: the bridge object exists,
    // the plugin does not. This is the case an OTA must survive.
    installBridge({ available: false })
    expect(hasNativeLiveActivity()).toBe(false)
  })

  it('reports present, and posts the payload, when the plugin is there', async () => {
    installBridge()
    expect(hasNativeLiveActivity()).toBe(true)
    const payload = { legHeadline: '6' } as LiveActivityPayload
    expect(await startLiveActivity(payload)).toBe(true)
    expect(plugin.start).toHaveBeenCalledWith(payload)
  })

  it('swallows a plugin that throws rather than failing the trip', async () => {
    installBridge()
    plugin.start.mockRejectedValue(new Error('budget exhausted'))
    expect(await startLiveActivity({} as LiveActivityPayload)).toBe(false)
  })

  it('starts nothing at all when there is no plugin', async () => {
    await syncLiveActivity(baseInput(), T(1))
    expect(liveActivityIsRunning()).toBe(false)
  })
})

describe('content — the arrival is the ITINERARY end, not leg 0’s', () => {
  it('quotes the last leg’s end, never the bus leg’s', () => {
    const content = buildLiveActivityContent(baseInput())!
    expect(content.arrivalEpochMs).toBe(ITINERARY_END)
    // The 2026-09-01 08:26:27 defect, named: the alight is 7 minutes earlier.
    expect(content.arrivalEpochMs).not.toBe(BUS_ALIGHT)
    expect(content.arrivalEpochMs).not.toBe(WALK_TO_STOP_END)
  })

  it('is still the itinerary end when the rider is ABOARD the bus', () => {
    // The exact situation that produced the wrong number: aboard leg 1, and
    // the tempting answer (this leg's end) is the wrong one.
    const content = buildLiveActivityContent(
      baseInput({
        progress: { currentLegIndex: 1 },
        riding: { legIndex: 1, vehicleId: 'v1' }
      })
    )!
    expect(content.phase).toBe('riding')
    expect(content.arrivalEpochMs).toBe(ITINERARY_END)
    expect(content.arrivalEpochMs).not.toBe(BUS_ALIGHT)
  })

  it('follows a live alight into the walk that comes after it', () => {
    // The bus runs 5 min late. buildLiveItinerary shifts the trailing walk by
    // the same amount, so the arrival moves too — the whole reason the number
    // is computed off the LIVE itinerary rather than the plan.
    const late = 5 * 60000
    const content = buildLiveActivityContent(
      baseInput({
        liveLegTimes: {
          1: {
            alightEpoch: BUS_ALIGHT + late,
            alightRealtime: true,
            boardEpoch: BUS_BOARD,
            boardRealtime: true,
            realtime: true
          }
        }
      })
    )!
    expect(content.arrivalEpochMs).toBe(ITINERARY_END + late)
    expect(content.arrivalIsRealtime).toBe(true)
  })

  it('does not claim realtime for a schedule-only trip', () => {
    expect(buildLiveActivityContent(baseInput())!.arrivalIsRealtime).toBe(false)
  })

  it('returns null when there is no itinerary to draw', () => {
    expect(
      buildLiveActivityContent(baseInput({ activeItinerary: null }))
    ).toBeNull()
    expect(
      buildLiveActivityContent(baseInput({ activeItinerary: { legs: [] } }))
    ).toBeNull()
  })
})

describe('content — the boarding, on getEffectiveBoardTimeMs semantics', () => {
  it('names the next boarding, its route and its stop', () => {
    const content = buildLiveActivityContent(baseInput())!
    expect(content).toMatchObject({
      boardEpochMs: BUS_BOARD,
      boardIsRealtime: false,
      legDetail: 'Nicollet Ave & 5th St',
      legHeadline: '6',
      legMode: 'BUS',
      phase: 'toStop'
    })
  })

  it('prefers the board field’s OWN realtime epoch', () => {
    const content = buildLiveActivityContent(
      baseInput({
        liveLegTimes: {
          1: {
            boardEpoch: BUS_BOARD + 180000,
            boardRealtime: true,
            realtime: true
          }
        }
      })
    )!
    expect(content.boardEpochMs).toBe(BUS_BOARD + 180000)
    expect(content.boardIsRealtime).toBe(true)
  })

  it('takes a rider-selected departure on the SAME run', () => {
    const content = buildLiveActivityContent(
      baseInput({ departureOverride: BUS_BOARD + 4 * 60000 })
    )!
    expect(content.boardEpochMs).toBe(BUS_BOARD + 4 * 60000)
  })

  it('ignores an override that names ANOTHER run', () => {
    // 8.2's rule: which run the rider intends is a different fact from when
    // the boarding in the itinerary happens. Beyond SAME_RUN_TOLERANCE_MS
    // (10 min) the override is about a different bus.
    const content = buildLiveActivityContent(
      baseInput({ departureOverride: BUS_BOARD + 61 * 60000 })
    )!
    expect(content.boardEpochMs).toBe(BUS_BOARD)
  })

  it('drops the boarding line once the rider is aboard', () => {
    const content = buildLiveActivityContent(
      baseInput({
        progress: { currentLegIndex: 1 },
        riding: { legIndex: 1, vehicleId: 'v1' }
      })
    )!
    expect(content.boardEpochMs).toBeNull()
    expect(content.legDetail).toBe('Lake St & Hennepin')
  })

  it('shows the mode and the destination on the final walk', () => {
    const content = buildLiveActivityContent(
      baseInput({ progress: { currentLegIndex: 2 } })
    )!
    expect(content).toMatchObject({
      boardEpochMs: null,
      legDetail: 'Office',
      legHeadline: 'Walk',
      phase: 'walking'
    })
  })

  it('reports the arrival once the trip is over', () => {
    const content = buildLiveActivityContent(
      baseInput({ arrivedAt: ITINERARY_END + 30000 })
    )!
    expect(content.phase).toBe('arrived')
    expect(content.arrivalEpochMs).toBe(ITINERARY_END + 30000)
  })
})

describe('the throttle', () => {
  const payload = (over: any = {}): LiveActivityPayload =>
    ({
      arrivalEpochMs: ITINERARY_END,
      arrivalIsRealtime: false,
      boardEpochMs: BUS_BOARD,
      boardIsRealtime: false,
      destinationName: 'Office',
      legDetail: 'Nicollet Ave & 5th St',
      legHeadline: '6',
      legMode: 'BUS',
      phase: 'toStop',
      tripId: 'ga-1',
      ...over
    } as LiveActivityPayload)

  it('always sends the first one', () => {
    expect(liveActivityUpdateDue(null, payload(), 0, 0)).toBe(true)
  })

  it('holds identical content back until the interval has passed', () => {
    expect(
      liveActivityUpdateDue(
        payload(),
        payload(),
        LIVE_ACTIVITY_UPDATE_INTERVAL_MS - 1,
        0
      )
    ).toBe(false)
    expect(
      liveActivityUpdateDue(
        payload(),
        payload(),
        LIVE_ACTIVITY_UPDATE_INTERVAL_MS,
        0
      )
    ).toBe(true)
  })

  it('holds back a changed TIME alone — the widget ticks those itself', () => {
    expect(
      liveActivityUpdateDue(
        payload(),
        payload({ arrivalEpochMs: ITINERARY_END + 120000 }),
        1000,
        0
      )
    ).toBe(false)
  })

  it('sends a leg change, a boarding and an alighting at once', () => {
    // boarding: toStop -> riding
    expect(
      liveActivityUpdateDue(payload(), payload({ phase: 'riding' }), 1000, 0)
    ).toBe(true)
    // leg change: a different route on the card
    expect(
      liveActivityUpdateDue(payload(), payload({ legHeadline: '21' }), 1000, 0)
    ).toBe(true)
    // alighting: the stop the card is about changes
    expect(
      liveActivityUpdateDue(
        payload(),
        payload({ legDetail: 'Lake St & Hennepin' }),
        1000,
        0
      )
    ).toBe(true)
  })
})

describe('the lifecycle', () => {
  beforeEach(() => installBridge())

  it('starts one card, then throttles the ticks behind it', async () => {
    await syncLiveActivity(baseInput(), T(1))
    expect(plugin.start).toHaveBeenCalledTimes(1)
    expect(liveActivityIsRunning()).toBe(true)

    // A second tick a few seconds later, same content: nothing sent.
    await syncLiveActivity(baseInput(), T(1) + 5000)
    expect(plugin.update).not.toHaveBeenCalled()
    expect(plugin.start).toHaveBeenCalledTimes(1)

    // A minute on, the times may have moved: one update.
    await syncLiveActivity(baseInput(), T(1) + LIVE_ACTIVITY_UPDATE_INTERVAL_MS)
    expect(plugin.update).toHaveBeenCalledTimes(1)
  })

  it('updates immediately when the rider boards', async () => {
    await syncLiveActivity(baseInput(), T(1))
    await syncLiveActivity(
      baseInput({
        progress: { currentLegIndex: 1 },
        riding: { legIndex: 1, vehicleId: 'v1' }
      }),
      T(1) + 2000
    )
    expect(plugin.update).toHaveBeenCalledTimes(1)
    expect(plugin.update.mock.calls[0][0]).toMatchObject({
      arrivalEpochMs: ITINERARY_END,
      phase: 'riding'
    })
  })

  it('never opens a card for a trip that is already over', async () => {
    await syncLiveActivity(baseInput({ arrivedAt: T(46) }), T(46))
    expect(plugin.start).not.toHaveBeenCalled()
    expect(liveActivityIsRunning()).toBe(false)
  })

  it('ends the card on arrival, leaving the arrival on it', async () => {
    await syncLiveActivity(baseInput(), T(1))
    await syncLiveActivity(baseInput({ arrivedAt: T(46) }), T(46))
    expect(plugin.end).toHaveBeenCalledTimes(1)
    expect(plugin.end.mock.calls[0][0]).toMatchObject({
      arrivalEpochMs: T(46),
      immediate: false,
      phase: 'arrived'
    })
    expect(liveActivityIsRunning()).toBe(false)
  })

  it('ends the card immediately when the rider exits Go Mode', async () => {
    await syncLiveActivity(baseInput(), T(1))
    await stopLiveActivity()
    expect(plugin.end).toHaveBeenCalledWith({ immediate: true })
    expect(liveActivityIsRunning()).toBe(false)
    // ...and a second exit posts nothing.
    await stopLiveActivity()
    expect(plugin.end).toHaveBeenCalledTimes(1)
  })

  it('replaces the card when the Go Mode SESSION changes', async () => {
    await syncLiveActivity(baseInput(), T(1))
    await syncLiveActivity(baseInput({ tripId: 'ga-2' }), T(2))
    expect(plugin.end).toHaveBeenCalledWith({ immediate: true })
    expect(plugin.start).toHaveBeenCalledTimes(2)
  })

  it('does not tear the card down for a mid-trip re-plan', async () => {
    // Same session id, a different itinerary: 2026-09-01's third ride
    // re-planned 14 times in 21 minutes, and each one must be an UPDATE.
    await syncLiveActivity(baseInput(), T(1))
    const replanned = itinerary()
    replanned.legs[1].routeShortName = '21'
    await syncLiveActivity(
      baseInput({ activeItinerary: replanned }),
      T(1) + 3000
    )
    expect(plugin.start).toHaveBeenCalledTimes(1)
    expect(plugin.end).not.toHaveBeenCalled()
    expect(plugin.update).toHaveBeenCalledTimes(1)
  })

  it('leaves no card running when the start is refused', async () => {
    plugin.start.mockResolvedValue({ reason: 'disabled', started: false })
    await syncLiveActivity(baseInput(), T(1))
    expect(liveActivityIsRunning()).toBe(false)
    // ...and the next tick tries again rather than updating a card that is
    // not there.
    await syncLiveActivity(baseInput(), T(2))
    expect(plugin.start).toHaveBeenCalledTimes(2)
    expect(plugin.update).not.toHaveBeenCalled()
  })
})
