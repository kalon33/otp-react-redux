import {
  BOARDING_CONFIRM,
  BOARDING_DENIAL_HOLD_MS,
  BOARDING_DENY,
  boardingDenialHolds,
  resolveBoardingOffer,
  ridingSuppressedByRider
} from '../../../lib/util/go-mode/boarding-confirmation'

/**
 * The rider's third ask from 2026-09-01 (backlog 6.10c): a way to say whether
 * they are on the bus.
 *
 * It is the companion to 6.1's board gate. That gate refuses a GPS-only
 * establishment without an accurate fix, tight distance and sixty seconds of
 * dwell at the boarding stop — which is right, and which also means a rider
 * who really did board early has no way to tell the app so. And in the other
 * direction the rider spent that ride saying it out loud with nowhere to put
 * it: "Algo is too aggressive about matching me to busss, I'm still on my
 * bike."
 */

const bikeLeg = { mode: 'BICYCLE', transitLeg: false } as any
const busLeg = { mode: 'BUS', transitLeg: true } as any

const ridingFact = (over: any = {}) =>
  ({
    boardedAt: 1_788_277_635_049,
    headsign: null,
    legIndex: 1,
    offRouteSince: null,
    routeId: '1:904',
    routeShortName: null,
    tripId: null,
    vehicleId: null,
    ...over
  } as any)

describe('resolveBoardingOffer', () => {
  it('offers "I\'m on the bus" while riding is unset and a bus is next', () => {
    const { offer, vehicleId } = resolveBoardingOffer({
      currentLeg: bikeLeg,
      matchedVehicleId: '1:8216',
      nextLeg: busLeg,
      riding: null
    })
    expect(offer).toBe(BOARDING_CONFIRM)
    // The vehicle the confirmation will name, so the riding fact it writes
    // carries a real id rather than a rider-shaped placeholder.
    expect(vehicleId).toBe('1:8216')
  })

  it('offers "Not on the bus" once riding has been declared', () => {
    expect(
      resolveBoardingOffer({
        currentLeg: busLeg,
        nextLeg: undefined,
        riding: ridingFact()
      }).offer
    ).toBe(BOARDING_DENY)
  })

  it('offers nothing when there is no bus in the picture at all', () => {
    // Biking home on the closing leg: "are you on the bus" is not a question
    // the rider has, and a chip asking it is the redundant prompt the rider
    // rule forbids.
    expect(
      resolveBoardingOffer({
        currentLeg: bikeLeg,
        nextLeg: { mode: 'WALK', transitLeg: false } as any,
        riding: null
      }).offer
    ).toBeNull()
  })

  it('still offers the confirm with nothing matched — the prompt fills the gap', () => {
    const { offer, vehicleId } = resolveBoardingOffer({
      currentLeg: bikeLeg,
      matchedVehicleId: null,
      nextLeg: busLeg,
      riding: null
    })
    expect(offer).toBe(BOARDING_CONFIRM)
    expect(vehicleId).toBeNull()
  })
})

describe('a denial holds the automatic gate off', () => {
  const T = 1_788_277_635_000

  it('holds for the window and then lets go', () => {
    expect(boardingDenialHolds(T, T + 1000)).toBe(true)
    expect(boardingDenialHolds(T, T + BOARDING_DENIAL_HOLD_MS - 1)).toBe(true)
    expect(boardingDenialHolds(T, T + BOARDING_DENIAL_HOLD_MS)).toBe(false)
    expect(boardingDenialHolds(null, T)).toBe(false)
  })

  it('refuses the evidence-free establishment that produced the complaint', () => {
    // 09-01 ride 2, 10:47:15: SET_RIDING with vehicleId null, confidence
    // "none", 3933 m from the board stop, on a bicycle at 8 m/s.
    expect(
      ridingSuppressedByRider({
        deniedAtMs: T,
        next: ridingFact(),
        nowMs: T + 30_000,
        prev: null
      })
    ).toBe(true)
  })

  it('does not stand in the way of a real vehicle', () => {
    // A denial is a statement about the app's guess, not a veto on reality.
    expect(
      ridingSuppressedByRider({
        deniedAtMs: T,
        next: ridingFact({ tripId: '1:trip-orange', vehicleId: '1:8216' }),
        nowMs: T + 30_000,
        prev: null
      })
    ).toBe(false)
  })

  it('never touches a riding fact already held', () => {
    // Retention is exempt, exactly as it is in the 6.1 gate: this can only
    // ever refuse to CREATE aboard-ness.
    expect(
      ridingSuppressedByRider({
        deniedAtMs: T,
        next: ridingFact(),
        nowMs: T + 30_000,
        prev: ridingFact({ vehicleId: '1:8216' })
      })
    ).toBe(false)
  })

  it('expires', () => {
    expect(
      ridingSuppressedByRider({
        deniedAtMs: T,
        next: ridingFact(),
        nowMs: T + BOARDING_DENIAL_HOLD_MS + 1,
        prev: null
      })
    ).toBe(false)
  })
})
