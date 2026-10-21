import {
  findNearbyVehicles,
  isLiveFrame,
  matchUserToVehicle,
  MAX_LIVE_FRAME_AGE_SECONDS
} from '../../../lib/util/go-mode/vehicle-matching'
import type { VehiclePosition } from '../../../lib/util/go-mode/vehicle-matching'

/**
 * 54.6 — on 2026-10-16 route 901 had no poll for hours; its last frames (the
 * newest 10,559 s old) sat in the store and the picker offered 1:31281 as the
 * train the rider was on. No reader rejected an ancient frame.
 */

const NOW = 1792117609000
const RIDER = { lat: 44.9778, lon: -93.265 }

const frame = (over: Partial<VehiclePosition>): VehiclePosition => ({
  heading: 0,
  label: '31281',
  lat: RIDER.lat,
  lon: RIDER.lon,
  nextStopId: '1:s',
  nextStopName: 'Station',
  patternId: '1:901:0:01',
  routeId: '1:901',
  seconds: NOW / 1000 - 30,
  speed: 0,
  stopStatus: 'STOPPED_AT',
  tripHeadsign: 'Mall of America',
  tripId: '1:t1',
  vehicleId: '1:31281',
  ...over
})

// 0.00001 deg of latitude is ~1.11 m
const north = (m: number) => RIDER.lat + m / 111000

describe('isLiveFrame', () => {
  it('keeps real frames and drops ones past the cap', () => {
    expect(isLiveFrame(frame({ seconds: NOW / 1000 - 268 }), NOW)).toBe(true)
    expect(
      isLiveFrame(
        frame({ seconds: NOW / 1000 - MAX_LIVE_FRAME_AGE_SECONDS - 1 }),
        NOW
      )
    ).toBe(false)
    expect(isLiveFrame(frame({ seconds: 1792107050 }), NOW)).toBe(false)
  })
  it('never drops a frame with no usable seconds', () => {
    expect(isLiveFrame(frame({ seconds: null as any }), NOW)).toBe(true)
    expect(isLiveFrame(frame({ seconds: 0 }), NOW)).toBe(true)
    expect(isLiveFrame(frame({ seconds: NaN }), NOW)).toBe(true)
  })
})

describe('the picker and matcher ignore hours-old frames', () => {
  const ancient = 1792107050
  it('findNearbyVehicles drops 1:31281 (~436 m, 10,559 s old)', () => {
    const v = frame({ lat: north(436), seconds: ancient })
    expect(
      findNearbyVehicles(RIDER.lat, RIDER.lon, [v], 1000, { nowMs: NOW })
    ).toHaveLength(0)
  })
  it('findNearbyVehicles keeps a 268 s old frame', () => {
    const v = frame({ lat: north(30), seconds: NOW / 1000 - 268 })
    expect(
      findNearbyVehicles(RIDER.lat, RIDER.lon, [v], 200, { nowMs: NOW })
    ).toHaveLength(1)
  })
  it('matchUserToVehicle drops 1:31286 at 21-71 m with the ancient frame', () => {
    for (const m of [21, 71]) {
      const v = frame({
        label: '31286',
        lat: north(m),
        seconds: ancient,
        vehicleId: '1:31286'
      })
      const r = matchUserToVehicle(
        RIDER.lat,
        RIDER.lon,
        null,
        [v],
        '1:901',
        null,
        80,
        null,
        null,
        { nowMs: NOW }
      )
      expect(r.vehicleId).toBeFalsy()
      expect(r.confidence).toBe('none')
    }
  })
  it('matchUserToVehicle drops the riding vehicle too, and matches a live one', () => {
    const old = frame({ lat: north(10), seconds: ancient })
    const live = frame({
      label: '31286',
      lat: north(30),
      vehicleId: '1:31286'
    })
    const r = matchUserToVehicle(
      RIDER.lat,
      RIDER.lon,
      null,
      [old, live],
      '1:901',
      null,
      80,
      null,
      null,
      { nowMs: NOW, ridingVehicleId: '1:31281' }
    )
    expect(r.vehicleId).toBe('1:31286')
    const only = matchUserToVehicle(
      RIDER.lat,
      RIDER.lon,
      null,
      [old],
      '1:901',
      null,
      80,
      null,
      null,
      { nowMs: NOW, ridingVehicleId: '1:31281' }
    )
    expect(only.vehicleId).toBeFalsy()
  })
})
