import { markTransfers } from '../../lib/util/transfer-times'

// 2026-10-19 America/Chicago: Gold alights 16:36:41 live (planned 16:36:58),
// the 94 boards 16:46:15 live (planned 16:48:28).
const GOLD_ALIGHT = Date.parse('2026-10-19T16:36:41-05:00')
const NINETY_FOUR_BOARD = Date.parse('2026-10-19T16:46:15-05:00')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const transit = (extra: any = {}): any => ({
  from: { name: 'Stop' },
  mode: 'BUS',
  transitLeg: true,
  ...extra
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const walk = (extra: any = {}): any => ({
  from: { name: 'Stop' },
  mode: 'WALK',
  transitLeg: false,
  ...extra
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mark = (legs: any[]) => markTransfers({ legs } as any)

describe('markTransfers (61.1)', () => {
  it('marks a transit leg that follows a transit leg', () => {
    const it = mark([
      transit({
        alightRealtime: true,
        arrivalDelay: -17,
        endTime: GOLD_ALIGHT
      }),
      transit({ startTime: NINETY_FOUR_BOARD })
    ])
    expect(it.legs[0].from.transferArrival).toBeUndefined()
    expect(it.legs[1].from.transferArrival).toEqual({
      delay: -17,
      realtime: true,
      time: GOLD_ALIGHT
    })
    expect(it.legs[1].from.name).toBe('Stop')
  })

  it('falls back to realTime and a zero delay', () => {
    const it = mark([
      transit({ endTime: 5, realTime: false }),
      transit({ startTime: 9 })
    ])
    expect(it.legs[1].from.transferArrival).toEqual({
      delay: 0,
      realtime: false,
      time: 5
    })
  })

  it('does not mark across a walk or bike leg', () => {
    const it = mark([transit({ endTime: 5 }), walk(), transit()])
    expect(it.legs[2].from.transferArrival).toBeUndefined()
    expect(it.legs[1].from.transferArrival).toBeUndefined()
  })

  it('does not mark an interlined continuation', () => {
    const it = mark([
      transit({ endTime: 5 }),
      transit({ interlineWithPreviousLeg: true })
    ])
    expect(it.legs[1].from.transferArrival).toBeUndefined()
  })

  it('does not mark the first leg', () => {
    const it = mark([transit({ endTime: 5 })])
    expect(it.legs[0].from.transferArrival).toBeUndefined()
  })
})
