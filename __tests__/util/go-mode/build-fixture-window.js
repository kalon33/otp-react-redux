import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  parseArgs,
  parseTime,
  readAllEntries,
  splitRides
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
 * SO THE DEFAULT IS THE LAST RIDE. --since/--until landed first and the default
 * did not follow them: on 2026-09-01 a wrap-up ran `--session mtin0l9c-yieexg`
 * with no window and got a 15.5 MB fixture spanning 13:26:27Z -> 15:48:47Z --
 * rides 1 and 2 -- which silently excluded the ride being reported, whose own
 * window opens three seconds later at 15:48:50Z. The banner said
 * `window: (none) .. (none)`. splitRides is what makes a default possible: a
 * START_GO_MODE arriving while NO trip is open is a ride boundary; one arriving
 * while a ride is already open is the itinerary swap it has always been.
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

  describe('splitRides — where one ride ends and the next begins', () => {
    const startEvt = (tIso) =>
      entry('START_GO_MODE', tIso, {
        itinerary: itinerary(tIso, tIso)
      })
    const stopEvt = (tIso) => entry('STOP_GO_MODE', tIso, null)

    it('cuts the two rides apart and does not cut on a mid-ride swap', () => {
      const rides = splitRides([
        startEvt('2026-08-28T14:00:00Z'),
        stopEvt('2026-08-28T14:20:00Z'),
        startEvt('2026-08-28T15:30:00Z'),
        // The swap: START_GO_MODE again with a trip already open.
        startEvt('2026-08-28T15:40:00Z'),
        stopEvt('2026-08-28T15:50:00Z')
      ])
      expect(rides).toHaveLength(2)
      expect(rides[1].startMs).toBe(T('2026-08-28T15:30:00Z'))
      expect(rides[1].endMs).toBe(T('2026-08-28T15:50:00Z'))
    })

    it('opens a ride on a RESUME_GO_MODE, which is all a resumed ride has', () => {
      // The 2026-08-31 18:52 mounts emitted no START_GO_MODE at all, so the
      // 104-minute session had no findable beginning and was unreplayable.
      const rides = splitRides([
        entry('RESUME_GO_MODE', '2026-08-31T23:52:55Z', {
          itinerary: itinerary('2026-08-31T23:52:55Z', '2026-09-01T00:10:00Z'),
          resumed: true
        }),
        stopEvt('2026-09-01T01:36:52Z')
      ])
      expect(rides).toHaveLength(1)
      expect(rides[0].startEvt.type).toBe('RESUME_GO_MODE')
    })

    it('closes a ride whose stream just stopped on the last entry it has', () => {
      const rides = splitRides([
        startEvt('2026-08-28T15:30:00Z'),
        fix('2026-08-28T15:45:00Z', 44.96)
      ])
      expect(rides).toHaveLength(1)
      expect(rides[0].endEvt).toBeNull()
      expect(rides[0].endMs).toBe(T('2026-08-28T15:45:00Z'))
    })
  })

  describe('--ride / --all', () => {
    it('defaults to no ride chosen, which main() reads as the last one', () => {
      expect(
        parseArgs(['node', 'build-fixture.js', '--latest']).ride
      ).toBeNull()
      expect(parseArgs(['node', 'build-fixture.js', '--latest']).all).toBe(
        false
      )
    })

    it('takes a 1-based ride number', () => {
      expect(parseArgs(['node', 'build-fixture.js', '--ride', '2']).ride).toBe(
        2
      )
    })

    it('refuses a ride 0, which would silently build ride 1', () => {
      expect(() =>
        parseArgs(['node', 'build-fixture.js', '--ride', '0'])
      ).toThrow(/1-based/)
    })

    it('refuses --all and --ride together', () => {
      expect(() =>
        parseArgs(['node', 'build-fixture.js', '--all', '--ride', '1'])
      ).toThrow(/pick one/)
    })
  })

  describe('the default, un-windowed, on a two-ride session', () => {
    let dir
    let out
    let banner
    beforeAll(() => {
      dir = writeLogDir()
      out = path.join(dir, 'defaulted.json')
      banner = execFileSync(
        process.execPath,
        [
          BUILDER,
          '--session',
          'one-session-two-rides',
          '--label',
          'defaulted',
          '--logs-dir',
          dir,
          '--out',
          out
        ],
        { encoding: 'utf8' }
      )
    })
    afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

    it('builds the LAST ride, not the whole session', () => {
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      // Before 2026-09-02 this bracketed 14:00:00 -> 15:50:00: both rides and
      // the parked hour between them, under a banner claiming no window at all.
      expect(fixture.meta.startMs).toBe(T('2026-08-28T15:30:00Z'))
      expect(fixture.meta.endMs).toBe(T('2026-08-28T15:50:00Z'))
      expect(fixture.gpsTrack).toHaveLength(2)
    })

    it('names which ride it took and which it skipped', () => {
      expect(banner).toMatch(/ride:\s+2 of 2/)
      expect(banner).toMatch(/skipped ride 1/)
      expect(banner).toMatch(/--ride 1 to build it/)
    })

    it('records the ride number in meta, so a fixture on disk can be checked', () => {
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(fixture.meta.ride).toBe(2)
      expect(fixture.meta.rideCount).toBe(2)
      expect(fixture.meta.resumed).toBe(false)
    })
  })

  describe('--ride 1 and --all', () => {
    let dir
    beforeAll(() => {
      dir = writeLogDir()
    })
    afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

    const build = (out, extra) =>
      execFileSync(
        process.execPath,
        [
          BUILDER,
          '--session',
          'one-session-two-rides',
          '--label',
          path.basename(out, '.json'),
          '--logs-dir',
          dir,
          '--out',
          out,
          ...extra
        ],
        { encoding: 'utf8' }
      )

    it('--ride 1 builds the morning ride and nothing after it', () => {
      const out = path.join(dir, 'first.json')
      build(out, ['--ride', '1'])
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(fixture.meta.startMs).toBe(T('2026-08-28T14:00:00Z'))
      expect(fixture.meta.endMs).toBe(T('2026-08-28T14:20:00Z'))
      expect(fixture.gpsTrack).toHaveLength(1)
    })

    it('--all restores the old whole-session bracket, on request', () => {
      const out = path.join(dir, 'everything.json')
      const banner = build(out, ['--all'])
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(fixture.meta.startMs).toBe(T('2026-08-28T14:00:00Z'))
      expect(fixture.meta.endMs).toBe(T('2026-08-28T15:50:00Z'))
      expect(fixture.gpsTrack).toHaveLength(3)
      expect(banner).toMatch(/ride:\s+ALL 2/)
    })

    it('refuses a ride number the session does not have', () => {
      const out = path.join(dir, 'nope.json')
      expect(() => build(out, ['--ride', '9'])).toThrow()
    })
  })
})
