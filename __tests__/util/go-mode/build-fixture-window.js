import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  parseArgs,
  parseTime,
  readAllEntries
} from '../../../lib/util/go-mode/replay/build-fixture'

/**
 * A SESSION IS NOT A RIDE, and neither is a START_GO_MODE.
 *
 * The phone keeps one session id for as long as the app stays loaded, so
 * `mtdh67f3-0z5p24` covers both 2026-08-28 rides and the three parked hours
 * between them — seven hours end to end. Bracketing on the session alone turned
 * that into a 61 MB "fixture" (larger than the whole .git) which was two rides
 * and a car park, not an incident. And splitting on START_GO_MODE instead would
 * not have helped: `beginGoMode` re-dispatches it on every itinerary swap, so
 * that session carries ELEVEN of them for two rides. An instant is the only
 * unambiguous cut, which is why the flags are --since/--until.
 *
 * The de-duplication guarded here is a separate defect found the same day: the
 * debug-log client re-POSTs a batch whose delivery it could not confirm, so
 * 3.1-3.5% of every 08-27..08-29 record is a byte-identical repeat carrying the
 * same action `t` and differing only in the sidecar's `recv`. Un-deduplicated
 * those reach the fixture, and a replay is then driven by a GPS track the ride
 * never produced.
 */

const BUILDER = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/build-fixture.js'
)

const T = (iso) => Date.parse(iso)

/** A recorded action line, as the sidecar writes it. */
const entry = (type, tIso, payload, recv) => ({
  device: 'dev-test',
  payload,
  recv: recv ?? T(tIso) / 1000,
  session: 'one-session-two-rides',
  t: T(tIso),
  type
})

const itinerary = (fromIso, toIso) => ({
  duration: (T(toIso) - T(fromIso)) / 1000,
  endTime: T(toIso),
  legs: [
    {
      distance: 900,
      duration: 300,
      endTime: T(fromIso) + 300000,
      legGeometry: { points: '_p~iF~ps|U' },
      mode: 'BICYCLE',
      startTime: T(fromIso),
      transitLeg: false
    },
    {
      distance: 8000,
      duration: 900,
      endTime: T(toIso),
      legGeometry: { points: '_p~iF~ps|U' },
      mode: 'BUS',
      routeId: '1:904',
      startTime: T(fromIso) + 300000,
      transitLeg: true
    }
  ],
  startTime: T(fromIso)
})

const fix = (tIso, lat) =>
  entry('UPDATE_POSITION', tIso, {
    coords: { accuracy: 8, latitude: lat, longitude: -93.27, speed: 6.2 },
    timestamp: T(tIso)
  })

/**
 * One session, two rides an hour apart, plus a re-POSTed batch in the middle of
 * the second — the shape of the real 8/28 recording, small enough to assert on.
 */
const writeLogDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-fixture-'))
  const morningFix = fix('2026-08-28T14:05:00Z', 44.9)
  const lines = [
    entry('START_GO_MODE', '2026-08-28T14:00:00Z', {
      itinerary: itinerary('2026-08-28T14:00:00Z', '2026-08-28T14:20:00Z')
    }),
    morningFix,
    // The re-POST: byte-identical including `t`, only `recv` moved on.
    { ...morningFix, recv: morningFix.recv + 1.8 },
    entry('STOP_GO_MODE', '2026-08-28T14:20:00Z', null),
    // ...an hour parked, no Go Mode at all...
    entry('START_GO_MODE', '2026-08-28T15:30:00Z', {
      itinerary: itinerary('2026-08-28T15:30:00Z', '2026-08-28T15:50:00Z')
    }),
    fix('2026-08-28T15:35:00Z', 44.95),
    // A swapped-in itinerary mid-ride: START_GO_MODE again, same trip.
    entry('START_GO_MODE', '2026-08-28T15:40:00Z', {
      itinerary: itinerary('2026-08-28T15:40:00Z', '2026-08-28T15:50:00Z')
    }),
    fix('2026-08-28T15:45:00Z', 44.96),
    entry('STOP_GO_MODE', '2026-08-28T15:50:00Z', null)
  ]
  fs.writeFileSync(
    path.join(dir, 'debug-2026-08-28.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
  return dir
}

describe('util > go-mode > build-fixture windowing', () => {
  describe('--since / --until values', () => {
    it('takes epoch milliseconds and any ISO instant', () => {
      expect(parseTime('1787968604040', '--since')).toBe(1787968604040)
      expect(parseTime('2026-08-29T01:56:44Z', '--since')).toBe(1787968604000)
    })

    it('refuses a seconds stamp rather than silently landing in 1970', () => {
      // The failure this prevents is invisible: a 1970 window matches nothing,
      // and the builder's "no entries found" reads as "the ride wasn't recorded".
      expect(() => parseTime('1787968604', '--since')).toThrow(/SECONDS/)
    })

    it('refuses anything it cannot read as a time', () => {
      expect(() => parseTime('yesterday', '--until')).toThrow(/cannot parse/)
      expect(() => parseTime(undefined, '--until')).toThrow(/needs a value/)
    })
  })

  describe('parseArgs', () => {
    it('defaults to an unbounded window, as it always did', () => {
      const args = parseArgs(['node', 'build-fixture.js', '--latest'])
      expect(args.sinceMs).toBe(-Infinity)
      expect(args.untilMs).toBe(Infinity)
    })

    it('carries both bounds', () => {
      const args = parseArgs([
        'node',
        'build-fixture.js',
        '--session',
        'mtdh67f3-0z5p24',
        '--since',
        '2026-08-29T01:56:44Z',
        '--until',
        '2026-08-29T02:36:00Z'
      ])
      expect(args.session).toBe('mtdh67f3-0z5p24')
      expect(args.untilMs - args.sinceMs).toBe(2356000)
    })

    it('rejects a backwards window instead of writing an empty fixture', () => {
      expect(() =>
        parseArgs([
          'node',
          'build-fixture.js',
          '--since',
          '2026-08-29T03:00:00Z',
          '--until',
          '2026-08-29T02:00:00Z'
        ])
      ).toThrow(/empty/)
    })
  })

  describe('readAllEntries', () => {
    let dir
    beforeAll(() => {
      dir = writeLogDir()
    })
    afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

    it('drops the re-POSTed copy and nothing else', () => {
      const { duplicates, entries } = readAllEntries(dir)
      expect(duplicates).toBe(1)
      // Three GPS fixes were written; one of them twice.
      expect(entries.filter((e) => e.type === 'UPDATE_POSITION')).toHaveLength(
        3
      )
      // ...and the survivor is the FIRST delivery, not the retry.
      const morning = entries.find((e) => e.type === 'UPDATE_POSITION')
      expect(morning.recv).toBe(T('2026-08-28T14:05:00Z') / 1000)
    })

    it('keeps only what the window covers', () => {
      const { entries } = readAllEntries(
        dir,
        T('2026-08-28T15:30:00Z'),
        T('2026-08-28T15:50:00Z')
      )
      expect(entries.every((e) => e.t >= T('2026-08-28T15:30:00Z'))).toBe(true)
      expect(entries.some((e) => e.t === T('2026-08-28T14:05:00Z'))).toBe(false)
    })
  })

  describe('the script, end to end on a two-ride session', () => {
    let dir
    let out
    beforeAll(() => {
      dir = writeLogDir()
      out = path.join(dir, 'scoped.json')
      execFileSync(
        process.execPath,
        [
          BUILDER,
          '--session',
          'one-session-two-rides',
          '--label',
          'scoped',
          '--logs-dir',
          dir,
          '--out',
          out,
          '--since',
          '2026-08-28T15:30:00Z',
          '--until',
          '2026-08-28T15:50:00Z'
        ],
        { encoding: 'utf8' }
      )
    })
    afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

    it('builds the ride the window names, not the first one in the session', () => {
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      // Unscoped this resolves to the 14:00 trip — `events.find(START_GO_MODE)`
      // is the first in the SESSION, and the session outlives the ride.
      expect(fixture.meta.startMs).toBe(T('2026-08-28T15:30:00Z'))
      expect(fixture.meta.endMs).toBe(T('2026-08-28T15:50:00Z'))
      expect(fixture.itinerary.startTime).toBe(T('2026-08-28T15:30:00Z'))
    })

    it('leaves the other ride and the parked hour out of the track', () => {
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(fixture.gpsTrack).toHaveLength(2)
      expect(
        fixture.gpsTrack.every((g) => g.tMs >= T('2026-08-28T15:30:00Z'))
      ).toBe(true)
    })

    it('records the itinerary swapped in mid-ride', () => {
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(fixture.itinerarySwaps).toHaveLength(1)
      expect(fixture.itinerarySwaps[0].tMs).toBe(T('2026-08-28T15:40:00Z'))
      // The trip's own itinerary is not repeated in there.
      expect(fixture.itinerarySwaps[0].itinerary.startTime).not.toBe(
        fixture.itinerary.startTime
      )
    })
  })
})
