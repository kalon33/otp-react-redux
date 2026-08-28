import {
  decideRiding,
  firstEstablishmentIsCorroborated,
  RIDING_ESTABLISH_MIN_SPEED_MPS,
  RIDING_MIN_PROGRESS
} from '../../../lib/util/go-mode/riding'

const NOW = 1787852667000 // 2026-08-27 13:44:27, the false boarding
const OFF_ROUTE_CLEAR_MS = 90000

const match = (over: any = {}) => ({
  confidence: 'confirmed',
  distanceMeters: 117,
  label: '1786',
  lastSeen: NOW,
  tripHeadsign: 'Express / I-94 / Downtown Mpls',
  tripId: '1:1184013',
  vehicleId: '1:1786',
  ...over
})

// The rider's PLANNED leg: the outbound 94 to Downtown St Paul.
const plannedLeg = (over: any = {}) => ({
  headsign: 'Downtown St Paul',
  mode: 'BUS',
  routeId: '1:94',
  routeShortName: '94',
  transitLeg: true,
  trip: { gtfsId: '1:1177858' },
  ...over
})

const onLeg = (over: any = {}) => ({
  distanceFromRoute: 10,
  isOnRoute: true,
  legIndex: 2,
  nearestPoint: [44.97613, -93.2679] as [number, number],
  progressAlongLeg: 0,
  progressAlongSegment: 0,
  segmentIndex: 0,
  ...over
})

const decide = (over: any = {}) =>
  decideRiding({
    matchedLeg: plannedLeg(),
    nowMs: NOW,
    offRouteClearMs: OFF_ROUTE_CLEAR_MS,
    prevRiding: null,
    riderSpeedMps: 0.1,
    routeMatch: onLeg(),
    vehicleMatch: { consecutiveMatches: 0, match: match() },
    ...over
  })

describe('util > go-mode > riding decision', () => {
  describe('the 2026-08-27 false boarding', () => {
    // The rider stood at 6th St S & 2nd Ave at 0.0-0.3 m/s for ten minutes,
    // waiting for the outbound 94 (trip 1:1177858, "Downtown St Paul"). The
    // matcher confirmed the INBOUND run 117m away (trip 1:1184013, "Express /
    // I-94 / Downtown Mpls"), riding was established on it, and because
    // classifyMissedBus opens with `if (riding) return null`, missed-bus
    // detection was disabled for the whole wait. The rider asked in the ride
    // thread whether they would be alerted. They would not have been.
    it('refuses to establish riding on a different run while standing still', () => {
      expect(decide().kind).toBe('none')
    })

    it('still refuses when the rider is merely walking about at the stop', () => {
      expect(decide({ riderSpeedMps: 1.4 }).kind).toBe('none')
    })

    it('accepts once the rider is actually being carried somewhere', () => {
      const d = decide({ riderSpeedMps: RIDING_ESTABLISH_MIN_SPEED_MPS + 5 })
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.tripId).toBe('1:1184013')
    })

    it('accepts an earlier run of the SAME service even at a standstill', () => {
      // Catching the earlier bus on your own route is the legitimate case this
      // must not block: different trip id, same headsign.
      const d = decide({
        vehicleMatch: {
          consecutiveMatches: 0,
          match: match({
            tripHeadsign: 'Downtown St Paul',
            tripId: '1:earlier-run'
          })
        }
      })
      expect(d.kind).toBe('set')
    })
  })

  describe('firstEstablishmentIsCorroborated', () => {
    it('waves through the planned run with no extra proof', () => {
      expect(
        firstEstablishmentIsCorroborated({
          matchedLeg: plannedLeg(),
          riderSpeedMps: 0,
          ridingTripId: '1:1177858',
          vehicleMatch: match({ tripId: '1:1177858' }),
          vehicleTrusted: true
        })
      ).toBe(true)
    })

    it('requires a trusted match before believing a different run at all', () => {
      expect(
        firstEstablishmentIsCorroborated({
          matchedLeg: plannedLeg(),
          riderSpeedMps: 20,
          ridingTripId: '1:1184013',
          vehicleMatch: match({ confidence: 'low' }),
          vehicleTrusted: false
        })
      ).toBe(false)
    })

    it('is inert when the plan names no trip', () => {
      expect(
        firstEstablishmentIsCorroborated({
          matchedLeg: plannedLeg({ trip: undefined }),
          riderSpeedMps: 0,
          ridingTripId: '1:whatever',
          vehicleMatch: match(),
          vehicleTrusted: true
        })
      ).toBe(true)
    })
  })

  describe('ordinary maintenance is unchanged', () => {
    it('establishes on the planned trip from leg progress alone', () => {
      const d = decide({
        routeMatch: onLeg({ progressAlongLeg: RIDING_MIN_PROGRESS }),
        vehicleMatch: null
      })
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.tripId).toBe('1:1177858')
    })

    it('does nothing when not aboard and not previously riding', () => {
      expect(
        decide({
          routeMatch: onLeg({ progressAlongLeg: 0 }),
          vehicleMatch: null
        }).kind
      ).toBe('none')
    })

    it('keeps boardedAt across a refresh', () => {
      const prev = {
        boardedAt: NOW - 600000,
        headsign: 'Downtown St Paul',
        legIndex: 1,
        offRouteSince: null,
        routeId: '1:94',
        routeShortName: '94',
        tripId: '1:1177858',
        vehicleId: '1:1786'
      }
      const d = decide({
        prevRiding: prev,
        routeMatch: onLeg({ progressAlongLeg: 0.4 }),
        vehicleMatch: null
      })
      // legIndex moved 1 -> 2, so this is a refresh rather than a no-op.
      expect(d.kind).toBe('set')
      expect(d.kind === 'set' && d.riding.boardedAt).toBe(NOW - 600000)
    })

    it('marks off-route, then clears only after the grace period', () => {
      const prev = {
        boardedAt: NOW - 600000,
        headsign: null,
        legIndex: 2,
        offRouteSince: null,
        routeId: '1:94',
        routeShortName: '94',
        tripId: '1:1177858',
        vehicleId: '1:1786'
      }
      const offRoute = { routeMatch: onLeg({ isOnRoute: false }) }

      const marked = decide({ ...offRoute, prevRiding: prev })
      expect(marked.kind).toBe('markOffRoute')
      expect(
        marked.kind === 'markOffRoute' && marked.riding.offRouteSince
      ).toBe(NOW)

      const stillWaiting = decide({
        ...offRoute,
        prevRiding: { ...prev, offRouteSince: NOW - 1000 }
      })
      expect(stillWaiting.kind).toBe('none')

      const cleared = decide({
        ...offRoute,
        prevRiding: { ...prev, offRouteSince: NOW - OFF_ROUTE_CLEAR_MS - 1 }
      })
      expect(cleared.kind).toBe('clear')
    })

    it('does nothing off-route when there was no riding fact', () => {
      expect(
        decide({ prevRiding: null, routeMatch: onLeg({ isOnRoute: false }) })
          .kind
      ).toBe('none')
    })
  })
})
