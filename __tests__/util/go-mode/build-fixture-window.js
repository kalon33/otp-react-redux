import { execFileSync, spawnSync } from 'child_process'
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
    // Two ONBOARD_CANDIDATE_SNAPSHOTs of DIFFERENT kinds. Since 2026-09-15 the
    // quiet access re-plan emits this type too (backlog 13.8), and it carries
    // no candidate alight stop — so the builder has to keep them apart or the
    // optimizer replay, which reads every entry of onboardCandidatePlans as a
    // plan it ranked and keys them on request.stopId, is fed plans nobody
    // ranked.
    entry('ONBOARD_CANDIDATE_SNAPSHOT', '2026-08-28T15:41:00Z', {
      request: { stopId: '1:56034' },
      response: { data: { plan: { itineraries: [] } } },
      tMs: T('2026-08-28T15:41:00Z')
    }),
    entry('ONBOARD_CANDIDATE_SNAPSHOT', '2026-08-28T15:42:00Z', {
      request: { reason: 'quiet-replan-scoped' },
      response: { data: { plan: { itineraries: [] } } },
      tMs: T('2026-08-28T15:42:00Z')
    }),
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

    it('keeps the quiet re-plan snapshots out of the optimizer series (13.8)', () => {
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      // The optimizer's own plan, still where the optimizer replay looks for
      // it, still keyed on the stop it departs from.
      expect(fixture.onboardCandidatePlans).toHaveLength(1)
      expect(fixture.onboardCandidatePlans[0].stopId).toBe('1:56034')
      // The quiet re-plan's, in its own series, tagged with which call site
      // issued it.
      expect(fixture.quietReplanPlans).toHaveLength(1)
      expect(fixture.quietReplanPlans[0].reason).toBe('quiet-replan-scoped')
      expect(fixture.quietReplanPlans[0].tMs).toBe(T('2026-08-28T15:42:00Z'))
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

/**
 * REPLAY FIDELITY (backlog 17.10, 2026-09-17).
 *
 * The 2026-09-15 15:34 ride was written up as unreplayable on two banner lines
 * that were both wrong, and the row that came out of it asked for two size caps
 * to be raised that nothing had hit. Measured from
 * ~/otp-debug-logs/debug-2026-09-15.jsonl, session mu346i5y-ng2uqc:
 *
 *   - its three real SET_ONBOARD_RESULTs are 124,321 / 127,210 / 128,613 chars,
 *     each with all five options intact, against a 1,000,000 ceiling; the
 *     fixture on disk carried them the whole time
 *   - the fourth is `setOnboardResult(null)` — the deliberate "clear the list"
 *     dispatch — and the builder counted its absent payload as a capture loss
 *   - the banner keyed "is this an onboard trip" on a BEGIN_ONBOARD_FLOW BEFORE
 *     START_GO_MODE, so a mid-trip flow read as "(not an onboard trip)"
 *   - every __summary in the whole 44 MB day file was UNDER the ceiling
 *     (largest 326,260) — no cap was involved in any of them
 *
 * And on ride B (mu35fwv5-8lyyq1) the flow began 2m17s before START_GO_MODE, so
 * the 60 s --since every caller passes excluded the entire evidence base; it
 * had to be rebuilt by hand with a 3-minute lead-in.
 */
describe('util > go-mode > build-fixture replay fidelity', () => {
  const ONBOARD_SESSION = 'onboard-before-start'
  const oEntry = (type, tIso, payload) => ({
    device: 'dev-test',
    payload,
    recv: T(tIso) / 1000,
    session: ONBOARD_SESSION,
    t: T(tIso),
    type
  })

  /** A GPS fix in the onboard session. */
  const fixAt = (tIso) =>
    oEntry('UPDATE_POSITION', tIso, {
      coords: { accuracy: 8, latitude: 44.9, longitude: -93.27, speed: 6.2 },
      timestamp: T(tIso)
    })

  const option = (stopId) => ({
    busArrivalEpoch: T('2026-09-15T20:58:00Z'),
    itinerary: itinerary('2026-09-15T20:58:00Z', '2026-09-15T21:20:00Z'),
    stopId,
    stopName: `stop ${stopId}`
  })

  /**
   * One ride whose onboard flow starts 2m17s before START_GO_MODE — ride B's
   * shape — plus a null-payload SET_ONBOARD_RESULT and a mid-trip flow, which
   * is ride A's.
   */
  const writeOnboardLogDir = (extra = []) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-fixture-onboard-'))
    const lines = [
      // A whole earlier ride inside the lead-in the builder now reads. It must
      // stay OUT of the ride split: the lead-in is lead-in, not scope.
      oEntry('START_GO_MODE', '2026-09-15T20:53:00Z', {
        itinerary: itinerary('2026-09-15T20:53:00Z', '2026-09-15T20:53:30Z')
      }),
      oEntry('STOP_GO_MODE', '2026-09-15T20:53:30Z', null),
      // ...the flow, before any trip exists...
      oEntry('BEGIN_ONBOARD_FLOW', '2026-09-15T20:53:56Z', {
        keepRouteId: '1:904'
      }),
      oEntry('SET_ONBOARD_TRIP', '2026-09-15T20:54:07Z', { id: '1:trip-a' }),
      oEntry('ONBOARD_CANDIDATE_SNAPSHOT', '2026-09-15T20:54:15Z', {
        request: { stopId: '1:53314' },
        response: { data: { plan: { itineraries: [] } } }
      }),
      oEntry('SET_ONBOARD_RESULT', '2026-09-15T20:54:19Z', {
        answeredCandidates: 2,
        options: [option('1:53314')],
        pendingCandidates: 0
      }),
      // ...2m17s later, the trip the flow produced...
      oEntry('START_GO_MODE', '2026-09-15T20:56:13Z', {
        itinerary: itinerary('2026-09-15T20:56:13Z', '2026-09-15T21:20:00Z')
      }),
      fixAt('2026-09-15T20:56:20Z'),
      // ...and a second, MID-TRIP flow: the rider taps "I'm on the bus" again.
      oEntry('SET_ONBOARD_TRIP', '2026-09-15T20:57:07Z', { id: '1:trip-b' }),
      oEntry('SET_ONBOARD_RESULT', '2026-09-15T20:57:19Z', {
        answeredCandidates: 5,
        options: [option('1:53313'), option('1:48084')],
        pendingCandidates: 0
      }),
      // The deliberate clear. `setOnboardResult(null)` is dispatched from three
      // places in lib/actions/go-mode.ts; null is its NORMAL shape.
      oEntry('SET_ONBOARD_RESULT', '2026-09-15T20:57:25Z', null),
      ...extra.map((e) => oEntry(e.type, e.tIso, e.payload)),
      oEntry('STOP_GO_MODE', '2026-09-15T20:57:33Z', null)
    ]
    fs.writeFileSync(
      path.join(dir, 'debug-2026-09-15.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    )
    return dir
  }

  /**
   * Build with the 60 s lead-in every caller actually passes, and return stdout
   * AND stderr: the loud stub block is a console.warn, and a warning nobody can
   * see in the output is the whole defect being fixed here.
   */
  const buildWith60s = (dir, out) => {
    const res = spawnSync(
      process.execPath,
      [
        BUILDER,
        '--session',
        ONBOARD_SESSION,
        '--label',
        'onboard',
        '--logs-dir',
        dir,
        '--out',
        out,
        '--since',
        String(T('2026-09-15T20:56:13Z') - 60000),
        '--until',
        '2026-09-15T20:57:33Z'
      ],
      { encoding: 'utf8' }
    )
    if (res.status !== 0) {
      throw new Error(`builder exited ${res.status}: ${res.stderr}`)
    }
    return res.stdout + res.stderr
  }

  describe('a 60 s lead-in no longer excludes the onboard flow', () => {
    let banner, dir, out
    beforeAll(() => {
      dir = writeOnboardLogDir()
      out = path.join(dir, 'onboard.json')
      banner = buildWith60s(dir, out)
    })
    afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

    it('reaches back past --since to the flow that set the trip up', () => {
      // --since is 20:55:13; the flow opened at 20:53:56, a minute and a half
      // EARLIER. Before 2026-09-17 --since was a hard read floor and this was
      // simply unreachable.
      expect(banner).toMatch(/flow began 137s BEFORE the trip/)
      expect(banner).toContain('reached back to 2026-09-15T20:53:56.000Z')
    })

    it('keeps the candidate plan the flow ranked before the trip started', () => {
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      // 20:54:15, i.e. before --since. This is the plan the ranking bugs of
      // 15.9 / 17.2 / 17.3 are read out of.
      expect(fixture.onboardCandidatePlans.map((p) => p.stopId)).toContain(
        '1:53314'
      )
    })

    it('still lets --since scope which RIDES exist', () => {
      // The lead-in is lead-in only: a START_GO_MODE inside it must not become
      // a ride of its own, or --since would stop meaning anything.
      expect(banner).toMatch(/ride:\s+1 of 1/)
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(fixture.meta.startMs).toBe(T('2026-09-15T20:56:13Z'))
    })
  })

  describe('a null payload is a shape, not a capture loss', () => {
    let banner, dir, out
    beforeAll(() => {
      dir = writeOnboardLogDir()
      out = path.join(dir, 'onboard.json')
      banner = buildWith60s(dir, out)
    })
    afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

    it('does not report SET_ONBOARD_RESULT as stubbed for a deliberate clear', () => {
      expect(banner).toMatch(/stubbed payloads:\s+none/)
      expect(banner).not.toContain('REPLACED BY A STUB')
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(fixture.meta.stubbed).toEqual({})
    })

    it('reports the onboard flow from what the fixture HOLDS', () => {
      // Ride A's banner said "(not an onboard trip)" for a ride that ran the
      // flow twice, because the line keyed on a pre-START BEGIN_ONBOARD_FLOW.
      // The fixture had the options all along.
      expect(banner).toContain('onboard flow:     trip + options')
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(fixture.onboard.result.payload.options).toHaveLength(2)
      expect(fixture.onboard.trip.payload.id).toBe('1:trip-b')
    })
  })

  describe('when a payload really was replaced, the report says which cap', () => {
    const buildWithStub = (payload) => {
      const dir = writeOnboardLogDir([
        { payload, tIso: '2026-09-15T20:57:28Z', type: 'ROUTING_RESPONSE' }
      ])
      const out = path.join(dir, 'onboard.json')
      const banner = buildWith60s(dir, out)
      const fixture = JSON.parse(fs.readFileSync(out, 'utf8'))
      fs.rmSync(dir, { force: true, recursive: true })
      return { banner, fixture }
    }

    it('records the loss in the fixture, not only on the console', () => {
      const { fixture } = buildWithStub({ __summary: true, chars: 326260 })
      expect(fixture.meta.stubbed.ROUTING_RESPONSE).toEqual({
        count: 1,
        markers: ['__summary'],
        maxChars: 326260
      })
    })

    it('says NO CAP was involved for a summary under the ceiling', () => {
      // The whole 2026-09-15 day file was this case. Raising
      // MAX_FULL_PAYLOAD_CHARS would have changed nothing, and the row asked
      // for exactly that.
      const { banner } = buildWithStub({ __summary: true, chars: 326260 })
      expect(banner).toContain('NO SIZE CAP IS INVOLVED')
      expect(banner).not.toContain('Raise all four rungs')
    })

    it('names MAX_FULL_PAYLOAD_CHARS when the payload really was over it', () => {
      const { banner } = buildWithStub({ __summary: true, chars: 1200000 })
      expect(banner).toContain('MAX_FULL_PAYLOAD_CHARS')
      expect(banner).toContain('Raise all four rungs')
      expect(banner).not.toContain('NO SIZE CAP IS INVOLVED')
    })

    it('names the sidecar cap, and its DEPLOY, for a truncated line', () => {
      const { banner } = buildWithStub({ __truncated_chars: 1300000 })
      expect(banner).toContain('DEBUG_LOG_MAX_LINE_CHARS')
      expect(banner).toMatch(/DEPLOY, not an OTA/)
    })
  })
})
