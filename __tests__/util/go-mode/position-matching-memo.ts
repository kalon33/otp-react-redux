import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { matchPositionToRoute } from '../../../lib/util/go-mode/position-matching'
import type { RouteMatchResult } from '../../../lib/util/go-mode/position-matching'

/**
 * 75.37 (J8): matchPositionToRoute memoises each leg's cumulative-distance
 * array per `legGeometry` object. The memo must change NO result: replaying a
 * whole recorded GPS track through legs whose geometry objects are already
 * cached must produce byte-identical matches to replaying it through freshly
 * cloned legs (every geometry object new, so every array is rebuilt).
 *
 * Three TRACKED slices (so this runs on a clean clone): an arrival, an
 * auto-switch and a multi-leg transfer ride.
 */

const SLICES = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures/slices'
)
const NAMES = [
  'ride-1020-0907-arrival-slice',
  'ride-1020-0907-auto-slice',
  'ride-1020-1629-transfer-slice'
]

const replay = (legs: any[], track: any[]) => {
  let currentLegIndex = 0
  let prev: RouteMatchResult | null = null
  const out: Array<RouteMatchResult | null> = []
  for (const fix of track) {
    const m = matchPositionToRoute(
      [fix.lat, fix.lon],
      legs,
      currentLegIndex,
      prev
    )
    out.push(m)
    if (m) {
      prev = m
      currentLegIndex = m.legIndex
    }
  }
  return out
}

describe('util > go-mode > position-matching cumulative-distance memo', () => {
  describe.each(NAMES)('%s', (name) => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(SLICES, `${name}.json`), 'utf8')
    )
    const track = [...fixture.gpsTrack].sort((a: any, b: any) => a.tMs - b.tMs)

    it('replays identically through cached and freshly built arrays', () => {
      const legs = fixture.itinerary.legs
      const first = replay(legs, track) // builds the cache
      const cached = replay(legs, track) // pure cache hits
      const fresh = replay(JSON.parse(JSON.stringify(legs)), track) // all misses
      expect(first.length).toBe(track.length)
      expect(cached).toEqual(first)
      expect(fresh).toEqual(first)
      // Printed so a before/after run of the UNMEMOISED code can be diffed.
      const digest = crypto
        .createHash('sha1')
        .update(JSON.stringify(first))
        .digest('hex')
      // eslint-disable-next-line no-console
      console.log(`DIGEST ${name} ${track.length} fixes ${digest}`)
    })

    it('never serves a stale array after the geometry is replaced in place', () => {
      const legs = JSON.parse(JSON.stringify(fixture.itinerary.legs))
      const fix = track[Math.floor(track.length / 2)]
      const before = matchPositionToRoute([fix.lat, fix.lon], legs, 0, null)
      // Same legGeometry OBJECT, different encoded line: the memo must notice.
      const donor = legs.find((l: any) => l.legGeometry !== legs[0].legGeometry)
      const originalPoints = legs[0].legGeometry.points
      legs[0].legGeometry.points = donor.legGeometry.points
      const swapped = matchPositionToRoute([fix.lat, fix.lon], legs, 0, null)
      const reference = matchPositionToRoute(
        [fix.lat, fix.lon],
        JSON.parse(JSON.stringify(legs)),
        0,
        null
      )
      expect(swapped).toEqual(reference)
      legs[0].legGeometry.points = originalPoints
      expect(matchPositionToRoute([fix.lat, fix.lon], legs, 0, null)).toEqual(
        before
      )
    })
  })
})
