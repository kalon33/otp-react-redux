import { matchUserToVehicle } from '../../../lib/util/go-mode/vehicle-matching'
import { vehicleReachedBoardStop } from '../../../lib/util/go-mode/riding'
import fixture from '../../../lib/util/go-mode/replay/fixtures/orange-line-0729.json'
import ride1 from '../../../lib/util/go-mode/replay/fixtures/bike-false-board-1029.json'

/**
 * The bus with its doors open (backlog 6.38).
 *
 * The board gate that shipped with 6.1 reads one field: "a GTFS-RT record
 * whose `nextStopId` IS the boarding stop is a bus that has not arrived yet".
 * That is true of a bus APPROACHING the stop and false of one STANDING at it,
 * and Metro Transit's feed does not change `nextStopId` until the bus pulls
 * away — so the gate refused exactly the bus the rider was stepping onto, for
 * the whole time it was boardable.
 *
 * Both halves are read from committed recordings below, not asserted from the
 * backlog's prose.
 */

const BUS_LEG: any = (fixture as any).itinerary.legs[1]
/** The Orange Line run the rider actually caught on 2026-07-29. */
const TRIP_ID = '1:1173133'

/** Every 8140 record on the ridden trip, in feed order. */
const records = (fixture as any).vehicleSnapshots
  .flatMap((snapshot: any) =>
    (snapshot.payload?.vehicles || [])
      .filter((v: any) => v.vehicleId === '1:8140' && v.tripId === TRIP_ID)
      .map((v: any) => ({ ...v, tMs: snapshot.tMs }))
  )
  .sort((a: any, b: any) => a.tMs - b.tMs)

/** The first moment the gate lets the match speak for boarding. */
const firstReachedMs = (blind: boolean) => {
  const hit = records.find((v: any) =>
    vehicleReachedBoardStop(
      blind ? { nextStopId: v.nextStopId } : v,
      // A copy per call, so nothing can be cached across the two readings.
      { ...BUS_LEG }
    )
  )
  return hit ? hit.tMs : null
}

describe('util > go-mode > the dwelling bus (2026-07-29)', () => {
  describe('the recording still carries the dwell', () => {
    it('is the Orange Line leg boarding at I-35W & 46th St', () => {
      expect(BUS_LEG.transitLeg).toBe(true)
      expect(BUS_LEG.from.stopId).toBe('1:53543')
      expect(records.length).toBeGreaterThan(20)
    })

    it('names the rider’s own stop for the whole time it stands there', () => {
      // 17:27:49 -> 17:28:48 CDT. Every record in the window says the bus's
      // next stop is the one the rider is standing at, and every one of them
      // also says it is STOPPED_AT it.
      const dwelling = records.filter(
        (v: any) => v.tMs >= 1785364069000 && v.tMs <= 1785364129000
      )
      expect(dwelling).toHaveLength(5)
      dwelling.forEach((v: any) => {
        expect(v.nextStopId).toBe(BUS_LEG.from.stopId)
        expect(v.stopStatus).toBe('STOPPED_AT')
      })
    })

    it('and only stops naming it on departure', () => {
      const departing = records.find(
        (v: any) => v.nextStopId !== BUS_LEG.from.stopId
      )
      expect(departing.stopStatus).toBe('IN_TRANSIT_TO')
      // 17:28:52 CDT — 57 s after the doors opened.
      expect(departing.tMs).toBe(1785364132227)
    })
  })

  describe('the gate', () => {
    // FAILS AGAINST UNFIXED SOURCE: false. `nextStopId` alone cannot tell the
    // two cases apart, so a bus at the kerb read as one still on its way.
    it('treats a bus standing at the boarding stop as having reached it', () => {
      const stopped = records.find((v: any) => v.stopStatus === 'STOPPED_AT')
      expect(stopped.nextStopId).toBe(BUS_LEG.from.stopId)
      expect(vehicleReachedBoardStop(stopped, BUS_LEG)).toBe(true)
    })

    it('still refuses one that is only on its way there', () => {
      const approaching = records.find(
        (v: any) =>
          v.stopStatus === 'IN_TRANSIT_TO' &&
          v.nextStopId === BUS_LEG.from.stopId
      )
      expect(vehicleReachedBoardStop(approaching, BUS_LEG)).toBe(false)
    })

    it('is unchanged for a feed that publishes no status at all', () => {
      expect(
        vehicleReachedBoardStop(
          { nextStopId: BUS_LEG.from.stopId, stopStatus: null },
          BUS_LEG
        )
      ).toBe(false)
      expect(vehicleReachedBoardStop({ nextStopId: '1:52719' }, BUS_LEG)).toBe(
        true
      )
    })

    // FAILS AGAINST UNFIXED SOURCE: both readings are 1785364132227.
    it('lets the match speak for boarding a minute earlier', () => {
      const blind = firstReachedMs(true)
      const seeing = firstReachedMs(false)
      expect(blind).toBe(1785364132227)
      // 17:27:49 CDT: the first record of the dwell.
      expect(seeing).toBe(1785364069150)
      // The whole dwell, recovered — and 46 s ahead of the 17:28:35 GPS
      // establishment that 6.28's fix produced on this same recording, which
      // is the latency this row is about.
      expect(Math.round(((blind as number) - (seeing as number)) / 1000)).toBe(
        63
      )
    })
  })

  describe('what a match can now see', () => {
    // FAILS AGAINST UNFIXED SOURCE: undefined. stopStatus was on
    // VehiclePosition and nowhere downstream of it, so neither decideRiding
    // nor the boarding-prompt auto-confirm could ask the question above.
    it('carries stopStatus out of matchUserToVehicle', () => {
      const stopped = records.find((v: any) => v.stopStatus === 'STOPPED_AT')
      const match = matchUserToVehicle(
        stopped.lat,
        stopped.lon,
        null,
        [stopped],
        null,
        null
      )
      expect(match.vehicleId).toBe('1:8140')
      expect(match.stopStatus).toBe('STOPPED_AT')
      expect(vehicleReachedBoardStop(match, BUS_LEG)).toBe(true)
    })

    it('reports null rather than undefined when the feed omits it', () => {
      const stopped = records.find((v: any) => v.stopStatus === 'STOPPED_AT')
      const match = matchUserToVehicle(
        stopped.lat,
        stopped.lon,
        null,
        [{ ...stopped, stopStatus: undefined }],
        null,
        null
      )
      expect(match.stopStatus).toBeNull()
    })
  })

  describe('6.1a is not weakened', () => {
    /**
     * 2026-09-01 ride 1, 08:26:26 CDT: the rider was on the platform at
     * 0.0-0.9 m/s, `CONFIRM_VEHICLE` and `SET_RIDING` fired 3 ms apart on ONE
     * poll of 8139, and the row this test protects is that the app must have
     * refused it. The record is read from the recording, not retyped.
     */
    const RIDE1_LEG: any = (ride1 as any).itinerary.legs[0]
    const falseBoardRecord = (ride1 as any).vehicleSnapshots
      .flatMap((snapshot: any) =>
        (snapshot.payload?.vehicles || [])
          .filter((v: any) => v.vehicleId === '1:8139')
          .map((v: any) => ({ ...v, tMs: snapshot.tMs }))
      )
      .sort((a: any, b: any) => a.tMs - b.tMs)[0]

    it('the bus that produced the false board was still on its way in', () => {
      expect(RIDE1_LEG.from.stopId).toBe('1:56831')
      expect(falseBoardRecord.nextStopId).toBe(RIDE1_LEG.from.stopId)
      expect(falseBoardRecord.stopStatus).toBe('IN_TRANSIT_TO')
      // 20 m/s on the freeway, not a bus with its doors open.
      expect(falseBoardRecord.speed).toBeGreaterThan(15)
    })

    it('and the gate still refuses it', () => {
      expect(vehicleReachedBoardStop(falseBoardRecord, RIDE1_LEG)).toBe(false)
    })
  })
})
