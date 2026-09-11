import { ADD_NOTIFICATION, START_GO_MODE } from '../../../lib/actions/go-mode'
import { checkLeaveSoon } from '../../../lib/util/go-mode/notification-service'
import { restoreDateNowBehavior, setTestTime } from '../../test-utils'
import goModeReducer from '../../../lib/reducers/go-mode'

/**
 * "TIME TO GO" FIRED THREE TIMES IN 4m57s (2026-09-09, backlog 13.2).
 *
 * `ADD_NOTIFICATION` ids `LEAVE_SOON_METRO Orange Line_I-35W & 98th St
 * Station_…` at 08:17:34, 08:21:49 and 08:22:31 — each in the same second as a
 * `START_GO_MODE`, the ride's two itinerary swaps. The daemon paged it as
 * `notification-repeat` at 08:21:49.
 *
 * The dedup itself was never at fault: `checkLeaveSoon` asks
 * `wasRecentlySent` over a 30-minute window, and the id's context (route +
 * boarding stop) was identical all three times. What defeated it is the
 * `START_GO_MODE` reducer, which filters `sentNotifications` down to the alerts
 * keyed to a physical stop and lets everything else re-arm — so each swap
 * erased the one id that would have suppressed the next "time to go".
 *
 * A same-connection swap changes neither the route nor the stop the rider is
 * walking to, which is exactly why LEAVE_SOON belongs with the survivors; a
 * re-plan onto a different route or stop carries a different context and still
 * fires.
 */

const initial = goModeReducer(undefined, { type: '@@INIT' } as any)

const ROUTE = 'METRO Orange Line'
const STOP = 'I-35W & 98th St Station'

/** The ride's own shape: bike access leg into the Orange Line. */
const accessLeg: any = {
  mode: 'BICYCLE',
  to: { name: STOP }
}
const busLeg: any = {
  from: { name: STOP },
  mode: 'BUS',
  routeLongName: ROUTE
}

/** Inside LEAVE_SOON_THRESHOLD_SECONDS, as all three recorded firings were. */
const progress: any = {
  timeUntilNextDeparture: 360,
  waitTimeAtStop: 90
}

const itinerary: any = { legs: [accessLeg, busLeg] }

const startGoMode = (state: any) =>
  goModeReducer(state, {
    payload: { itinerary, originalFrom: null, roundTrip: null },
    type: START_GO_MODE
  } as any)

/**
 * One tick's worth of the real chain: ask the service, and record whatever it
 * returns the way the tick does.
 */
const leaveSoonTick = (state: any): { fired: boolean; state: any } => {
  const event = checkLeaveSoon(
    progress,
    accessLeg,
    busLeg,
    state.notifications.sentNotifications
  )
  if (!event) return { fired: false, state }
  return {
    fired: true,
    state: goModeReducer(state, {
      payload: event,
      type: ADD_NOTIFICATION
    } as any)
  }
}

describe('13.2 — an itinerary swap does not re-arm "time to go"', () => {
  afterEach(restoreDateNowBehavior)

  // FAILS AGAINST UNFIXED SOURCE: 3 — the recorded 08:17:34 / 08:21:49 /
  // 08:22:31 pushes.
  it('fires once across three swaps of the same connection', () => {
    // The recorded instants, to the second.
    const TICKS = [
      1788959854000, // 08:17:34
      1788960109000, // 08:21:49
      1788960151000 // 08:22:31
    ]

    let state: any = { ...initial }
    let fired = 0
    for (const nowMs of TICKS) {
      setTestTime(nowMs)
      // Every one of these arrived in the same second as a START_GO_MODE.
      state = startGoMode(state)
      const tick = leaveSoonTick(state)
      state = tick.state
      if (tick.fired) fired++
    }

    expect(fired).toBe(1)
    expect(
      state.notifications.sentNotifications.filter((id: string) =>
        id.startsWith('LEAVE_SOON_')
      )
    ).toHaveLength(1)
  })

  it('keeps the id itself across the swap', () => {
    setTestTime(1788959854000)
    let state: any = startGoMode({ ...initial })
    state = leaveSoonTick(state).state
    const sent = state.notifications.sentNotifications.filter((id: string) =>
      id.startsWith('LEAVE_SOON_')
    )
    expect(sent).toHaveLength(1)

    setTestTime(1788960109000)
    state = startGoMode(state)
    expect(
      state.notifications.sentNotifications.filter((id: string) =>
        id.startsWith('LEAVE_SOON_')
      )
    ).toEqual(sent)
  })

  it('still fires for a re-plan onto a different boarding stop', () => {
    setTestTime(1788959854000)
    let state: any = startGoMode({ ...initial })
    state = leaveSoonTick(state).state
    expect(
      state.notifications.sentNotifications.some((id: string) =>
        id.startsWith(`LEAVE_SOON_${ROUTE}_${STOP}`)
      )
    ).toBe(true)

    // Same route, a stop further down the line: a different connection, and
    // the rider has a new walk to make.
    setTestTime(1788960109000)
    state = startGoMode(state)
    const elsewhere: any = {
      ...busLeg,
      from: { name: 'Knox Ave & American Blvd Station' }
    }
    const event = checkLeaveSoon(
      progress,
      { ...accessLeg, to: elsewhere.from },
      elsewhere,
      state.notifications.sentNotifications
    )
    expect(event?.id).toContain('Knox Ave & American Blvd Station')
  })

  it('and the survivors it was added beside are untouched', () => {
    setTestTime(1788959854000)
    const seeded: any = {
      ...initial,
      notifications: {
        ...initial.notifications,
        sentNotifications: [
          `APPROACH_STOP_${STOP}_1788959800000`,
          `ARRIVING_STOP_${STOP}_1788959800000`,
          'BOARD_BUS_APPROACHING_1:1346052_1788959800000',
          'BOARD_BUS_ARRIVING_1:1346052_1788959800000',
          `LEAVE_SOON_${ROUTE}_${STOP}_1788959800000`,
          // Not keyed to this connection: a swap is entitled to re-arm it.
          'TURN_ALERT_left onto 98th St_1788959800000'
        ]
      }
    }

    const after = startGoMode(seeded)
    expect(after.notifications.sentNotifications).toEqual([
      `APPROACH_STOP_${STOP}_1788959800000`,
      `ARRIVING_STOP_${STOP}_1788959800000`,
      'BOARD_BUS_APPROACHING_1:1346052_1788959800000',
      'BOARD_BUS_ARRIVING_1:1346052_1788959800000',
      `LEAVE_SOON_${ROUTE}_${STOP}_1788959800000`
    ])
  })
})
