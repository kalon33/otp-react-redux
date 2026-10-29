import { demoteTokenTransitHops } from '../../lib/util/itinerary'

/**
 * Backlog 75.13. Bike + transit answers carry "token" bus hops — bike, ride
 * one stop (often 0-1 s by the GTFS), bike on — and the list demotion that
 * pushes them below the same trip without the hop had two blind spots:
 *
 * 1. arriveBy. Every option is pinned to the deadline, so the hop-free
 *    alternative (the direct bike) ARRIVES later than the hop by design; the
 *    depart-at test "arrives within 5 min" never fires. The rider's cost in
 *    an arrive-by search is how early they must LEAVE.
 * 2. Only a CLOSING hop was looked at. A hop at the start of the transit chain
 *    (bike 1.4 km, then 340 m on the 444) or a single hop with a short walk
 *    after it (walk 198 m, 22 for 127 m, walk 120 m) kept its place.
 *
 * Numbers are OTP's answers from the fuzz session (desktop OTP, L1 n=118:
 * BICYCLE + transit, arriveBy Sun 2026-11-01 14:00, MVTA 2:30055 -> 2:30395;
 * n=44: walk + transit, Thu 2026-10-29 09:00, downtown -> 50 m away).
 */

// Sunday 2026-11-01 is CST (UTC-6) after 02:00; Thursday 10-29 is CDT (UTC-5).
const sun = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number)
  return Date.UTC(2026, 10, 1, h + 6, m, s)
}
const thu = (hms: string) => {
  const [h, m, s] = hms.split(':').map(Number)
  return Date.UTC(2026, 9, 29, h + 5, m, s)
}
const street = (mode: string, distance: number) => ({
  distance,
  mode,
  transitLeg: false
})
const ride = (routeId: string, distance: number) => ({
  distance,
  mode: 'BUS',
  routeId,
  transitLeg: true
})
const itin = (
  startTime: number,
  endTime: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  legs: any[],
  arriveBy: boolean
) =>
  ({
    endTime,
    legs,
    otp2QueryParams: { arriveBy },
    startTime
  } as never)
const bike = (m: number) => street('BICYCLE', m)
const walk = (m: number) => street('WALK', m)

describe('backlog 75.13 > token hops in an arrive-by search', () => {
  const ARRIVE = true
  // n=118 itinerary 0: the direct bike, pinned to the 14:00 deadline.
  const direct = itin(sun('13:54:04'), sun('14:00:00'), [bike(1171)], ARRIVE)
  // itinerary 1: bike 947 m, 444 for 340 m, bike 593 m — leaves 9.4 min
  // earlier than the direct bike and arrives 6.5 min before the deadline.
  const hop340 = itin(
    sun('13:44:40'),
    sun('13:53:33'),
    [bike(947), ride('2:444', 340), bike(593)],
    ARRIVE
  )
  // itinerary 2: bike 1441 m, then 280 m on the 444 in ONE second, and the
  // trip ends at the stop — a hop with nothing after it, only before.
  const hop280 = itin(
    sun('13:40:50'),
    sun('13:48:01'),
    [bike(1441), ride('2:444', 280)],
    ARRIVE
  )
  // itinerary 7: bike 1894 m, 444 for 647 m, bike 593 m.
  const hop647 = itin(
    sun('13:26:15'),
    sun('13:40:33'),
    [bike(1894), ride('2:444', 647), bike(593)],
    ARRIVE
  )
  // itinerary 6: a real ride — 1164 m on the Orange Line.
  const orange = itin(
    sun('13:27:01'),
    sun('13:40:35'),
    [bike(1575), ride('1:904', 1164), bike(677)],
    ARRIVE
  )

  it('demotes every 444 hop below the Orange Line and the direct bike', () => {
    // Fails before the fix: nothing moves (the 1:45 PM 444 card sat above the
    // Orange Line on screen, fuzz/app-30.png).
    const out = demoteTokenTransitHops([hop340, hop280, orange, hop647, direct])
    expect(out).toEqual([orange, direct, hop340, hop280, hop647])
  })

  it('keeps a hop whose hop-free version makes the rider leave much earlier', () => {
    // The direct bike would have to leave 13:30 — 14 min before the hop.
    const slowDirect = itin(
      sun('13:30:00'),
      sun('14:00:00'),
      [bike(5200)],
      ARRIVE
    )
    const input = [hop340, slowDirect]
    expect(demoteTokenTransitHops(input)).toBe(input)
  })
})

describe('backlog 75.13 > a token hop at the START of the transit chain', () => {
  const DEPART = false
  // n=44 itinerary 0: walk the whole way, 219 m.
  const walkOnly = itin(thu('09:00:00'), thu('09:05:03'), [walk(219)], DEPART)
  // n=44 itinerary 1: walk 198 m, the 22 for 127 m in 0 s, walk 120 m. The
  // walk after the hop is SHORTER than the hop, so the closing-hop rule never
  // looked at it; the walk before it is longer.
  const bus22 = itin(
    thu('09:01:25'),
    thu('09:07:34'),
    [walk(198), ride('1:22', 127), walk(120)],
    DEPART
  )

  it('demotes a single hop that a longer street leg leads into', () => {
    expect(demoteTokenTransitHops([bus22, walkOnly])).toEqual([walkOnly, bus22])
  })

  it('demotes a short first ride before the real one', () => {
    // bike 1823 m, 444 for 509 m, bike 200 m, Orange Line 8 km — against the
    // same Orange Line ride reached by bike, arriving 2 min later.
    const hopThenOrange = itin(
      thu('09:00:00'),
      thu('09:40:00'),
      [
        bike(1823),
        ride('2:444', 509),
        bike(200),
        ride('1:904', 8000),
        bike(300)
      ],
      DEPART
    )
    const orangeOnly = itin(
      thu('09:00:00'),
      thu('09:42:00'),
      [bike(2500), ride('1:904', 8000), bike(300)],
      DEPART
    )
    expect(demoteTokenTransitHops([hopThenOrange, orangeOnly])).toEqual([
      orangeOnly,
      hopThenOrange
    ])
  })

  it('keeps a short first ride that starts at the door', () => {
    // Mirror of "a token hop that ends at the door": 7 m to the stop, 400 m on
    // the bus — there is no longer street leg it could have been folded into.
    const doorstep = itin(
      thu('09:00:00'),
      thu('09:40:00'),
      [walk(7), ride('1:22', 400), walk(30), ride('1:904', 8000), walk(100)],
      DEPART
    )
    const orangeOnly = itin(
      thu('09:00:00'),
      thu('09:41:00'),
      [walk(600), ride('1:904', 8000), walk(100)],
      DEPART
    )
    const input = [doorstep, orangeOnly]
    expect(demoteTokenTransitHops(input)).toBe(input)
  })

  it('still compares by arrival in a depart-at search', () => {
    // Leaving later is not the rider's cost when they asked to depart at 9:
    // a hop-free version that arrives 15 min later keeps the hop on top.
    const lateWalk = itin(
      thu('09:10:00'),
      thu('09:25:00'),
      [walk(1200)],
      DEPART
    )
    const input = [bus22, lateWalk]
    expect(demoteTokenTransitHops(input)).toBe(input)
  })
})
