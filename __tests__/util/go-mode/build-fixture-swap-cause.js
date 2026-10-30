import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { swapCause } from '../../../lib/util/go-mode/replay/build-fixture'

/**
 * BACKLOG 75.30 — who made each itinerary swap, the rider or the app.
 *
 * A replay re-applies the rider's swaps at their recorded time and leaves the
 * app's to the app (replay-swaps.ts). The fixture kept only `{itinerary, tMs}`
 * for each swap, so nothing could tell the two apart; the day file can: every
 * door into `beginGoMode` records its cause first. The chains below are the
 * real ones, copied from the day files with their own offsets:
 *
 *  - 2026-10-26 `mvpik996-01erej` (debug-2026-10-26.jsonl): 12:14:00.944
 *    PLAN_RETARGET {source: anchor, verdict: applied} → 12:14:00.947
 *    START_GO_MODE; 12:16:56 the rider picks result 29 → 12:17:00.050
 *    START_GO_MODE {newTrip: true}; 12:27:09.193 AUTO_REPLAN
 *    quiet-replan-scoped accepted → 12:27:09.217 START_GO_MODE.
 *  - 2026-10-19 `mvfqu4i0-yd2epd`: 16:33:39.945 GO_MODE_CONTROL_TAP
 *    onboard-preview-confirm → CLEAR_ONBOARD → 16:33:39.950 START_GO_MODE.
 *  - 2026-10-20 `mvgr2jqp-b81j4g`: 09:24:26.809 GO_MODE_CONTROL_TAP
 *    faster-route-switch → .811 AUTO_REPLAN faster-route-aboard
 *    {autoApply: false} → .813 START_GO_MODE.
 *  - Older rides, before the markers: 2026-09-21 `mubbbiy9-6zjoq9` 09:03:00.133
 *    ONBOARD_CANDIDATE_SNAPSHOT {request.reason: quiet-replan-scoped} →
 *    .138 START_GO_MODE; 2026-09-15 `mu346i5y-ng2uqc` 15:43:06.5
 *    SET_ONBOARD_RESULT → 15:43:28.647 CLEAR_ONBOARD → .650 START_GO_MODE.
 */

const BUILDER = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/build-fixture.js'
)
const SESSION = 'mvpik996-01erej'
const T = (iso) => Date.parse(iso)

const entry = (type, tIso, payload, session = SESSION) => ({
  device: 'dev-test',
  kind: 'action',
  payload,
  recv: T(tIso) / 1000,
  session,
  t: T(tIso),
  type
})

const plan = (tripId, startIso) => ({
  duration: 1800,
  endTime: T(startIso) + 1800000,
  legs: [
    {
      distance: 900,
      duration: 300,
      endTime: T(startIso) + 300000,
      legGeometry: { points: '_p~iF~ps|U' },
      mode: 'BICYCLE',
      startTime: T(startIso),
      transitLeg: false
    },
    {
      distance: 8000,
      duration: 1500,
      endTime: T(startIso) + 1800000,
      legGeometry: { points: '_p~iF~ps|U' },
      mode: 'BUS',
      routeId: '1:904',
      startTime: T(startIso) + 300000,
      transitLeg: true,
      trip: { gtfsId: tripId }
    }
  ],
  startTime: T(startIso)
})

const start = (tIso, payload = {}) =>
  entry('START_GO_MODE', tIso, {
    itinerary: plan('1:1', tIso),
    multiStop: null,
    roundTrip: null,
    ...payload
  })

/** swapCause for the LAST entry of a chain (a START_GO_MODE). */
const causeOf = (chain) => swapCause(chain, chain.length - 1)

describe('75.30 swapCause — the rider or the app, from the day file', () => {
  it('a planner Start on another result is the rider (2026-10-26 12:17:00)', () => {
    expect(
      causeOf([
        start('2026-10-26T17:14:00.795Z', { newTrip: true }),
        entry('SET_VISIBLE_ITINERARY', '2026-10-26T17:16:56.417Z', {
          index: 29
        }),
        start('2026-10-26T17:17:00.050Z', { newTrip: true })
      ])
    ).toEqual({ by: 'rider', cause: 'start-trip', newTrip: true })
  })

  it('the anchor re-target is the app; the rider’s departure pick is the rider', () => {
    const retarget = (source) => [
      start('2026-10-26T17:14:00.795Z', { newTrip: true }),
      entry('SET_DEPARTURE_OVERRIDE', '2026-10-26T17:14:00.942Z', {
        ms: 1793035243000,
        source
      }),
      entry('PLAN_RETARGET', '2026-10-26T17:14:00.944Z', {
        source,
        tripId: '1:1384516',
        verdict: 'applied'
      }),
      start('2026-10-26T17:14:00.947Z')
    ]
    expect(causeOf(retarget('anchor'))).toEqual({
      by: 'app',
      cause: 'plan-retarget'
    })
    expect(causeOf(retarget('rider'))).toEqual({
      by: 'rider',
      cause: 'departure-pick'
    })
  })

  it('an accepted quiet re-plan is the app (2026-10-26 12:27:09)', () => {
    expect(
      causeOf([
        start('2026-10-26T17:17:00.050Z', { newTrip: true }),
        entry('ONBOARD_CANDIDATE_SNAPSHOT', '2026-10-26T17:27:09.191Z', {
          request: { reason: 'quiet-replan-scoped' }
        }),
        entry('AUTO_REPLAN', '2026-10-26T17:27:09.193Z', {
          accepted: true,
          autoApply: true,
          reason: 'quiet-replan-scoped'
        }),
        start('2026-10-26T17:27:09.217Z')
      ])
    ).toEqual({ by: 'app', cause: 'quiet-replan-scoped' })
  })

  it('the onboard Confirm is the rider (2026-10-19 16:33:39)', () => {
    expect(
      causeOf([
        start('2026-10-19T21:31:37.274Z'),
        entry('GO_MODE_CONTROL_TAP', '2026-10-19T21:33:38.932Z', {
          control: 'onboard-option-row',
          index: 0
        }),
        entry('GO_MODE_CONTROL_TAP', '2026-10-19T21:33:39.945Z', {
          control: 'onboard-preview-confirm',
          fromPreview: true,
          stopId: '1:57417'
        }),
        entry('CLEAR_ONBOARD', '2026-10-19T21:33:39.947Z', null),
        start('2026-10-19T21:33:39.950Z')
      ])
    ).toEqual({ by: 'rider', cause: 'onboard-preview-confirm' })
  })

  it('the faster-route Switch is the rider (2026-10-20 09:24:26)', () => {
    expect(
      causeOf([
        start('2026-10-20T14:08:48.238Z'),
        entry('GO_MODE_CONTROL_TAP', '2026-10-20T14:24:26.809Z', {
          control: 'faster-route-switch',
          kind: 'aboard'
        }),
        entry('AUTO_REPLAN', '2026-10-20T14:24:26.811Z', {
          accepted: true,
          autoApply: false,
          reason: 'faster-route-aboard'
        }),
        start('2026-10-20T14:24:26.813Z')
      ])
    ).toEqual({ by: 'rider', cause: 'faster-route-aboard' })
  })

  it('looks no further back than the swap before: a tap that caused THAT swap is not this one’s', () => {
    expect(
      causeOf([
        entry('GO_MODE_CONTROL_TAP', '2026-10-20T14:25:16.458Z', {
          control: 'onboard-preview-confirm'
        }),
        start('2026-10-20T14:25:16.460Z'),
        start('2026-10-20T14:25:20.000Z')
      ])
    ).toEqual({ by: 'unknown', cause: null })
  })

  it('a refused re-plan says nothing about the swap after it', () => {
    expect(
      causeOf([
        start('2026-10-20T14:07:04.217Z'),
        entry('AUTO_REPLAN', '2026-10-20T14:08:13.000Z', {
          accepted: false,
          reason: 'quiet-replan-scoped'
        }),
        start('2026-10-20T14:08:14.200Z')
      ])
    ).toEqual({ by: 'unknown', cause: null })
  })

  it('reads the older rides’ own markers, only right before the swap', () => {
    // 2026-09-21 09:03:00: a quiet re-plan before AUTO_REPLAN existed.
    expect(
      causeOf([
        start('2026-09-21T14:02:58.719Z'),
        entry('ONBOARD_CANDIDATE_SNAPSHOT', '2026-09-21T14:03:00.133Z', {
          request: { reason: 'quiet-replan-scoped' }
        }),
        start('2026-09-21T14:03:00.138Z')
      ])
    ).toEqual({ by: 'app', cause: 'quiet-replan-scoped' })
    // 2026-09-15 15:43:28: a tap on a listed alight option WAS the commit
    // until 17.1, and recorded no tap.
    expect(
      causeOf([
        start('2026-09-15T20:34:00.000Z'),
        entry('SET_ONBOARD_RESULT', '2026-09-15T20:43:06.500Z', {
          options: []
        }),
        entry('CLEAR_ONBOARD', '2026-09-15T20:43:28.647Z', null),
        start('2026-09-15T20:43:28.650Z')
      ])
    ).toEqual({ by: 'rider', cause: 'onboard-confirm' })
    // An anchor override 20 s before an unexplained swap is not its cause.
    expect(
      causeOf([
        start('2026-10-08T21:00:00.000Z'),
        entry('SET_DEPARTURE_OVERRIDE', '2026-10-08T21:06:27.132Z', {
          source: 'anchor'
        }),
        start('2026-10-08T21:06:47.155Z')
      ])
    ).toEqual({ by: 'unknown', cause: null })
  })
})

describe('75.30 build-fixture — swaps carry who made them', () => {
  let dir
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-cause-'))
    const lines = [
      start('2026-10-26T17:14:00.795Z', { newTrip: true }),
      entry('UPDATE_POSITION', '2026-10-26T17:14:01.000Z', {
        coords: { accuracy: 5, latitude: 44.916, longitude: -93.2622 },
        timestamp: T('2026-10-26T17:14:01.000Z')
      }),
      entry('PLAN_RETARGET', '2026-10-26T17:14:00.944Z', {
        source: 'anchor',
        verdict: 'applied'
      }),
      start('2026-10-26T17:14:00.947Z'),
      start('2026-10-26T17:17:00.050Z', { newTrip: true }),
      entry('AUTO_REPLAN', '2026-10-26T17:27:09.193Z', {
        accepted: true,
        autoApply: true,
        reason: 'quiet-replan-scoped'
      }),
      start('2026-10-26T17:27:09.217Z'),
      // Another session in the same file: never read for this one.
      entry(
        'GO_MODE_CONTROL_TAP',
        '2026-10-26T17:27:09.200Z',
        { control: 'onboard-preview-confirm' },
        'someone-else'
      ),
      entry('STOP_GO_MODE', '2026-10-26T18:01:16.000Z', null)
    ]
    fs.writeFileSync(
      path.join(dir, 'debug-2026-10-26.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
    )
  })
  afterAll(() => fs.rmSync(dir, { force: true, recursive: true }))

  const expected = [
    { by: 'app', cause: 'plan-retarget', tMs: T('2026-10-26T17:14:00.947Z') },
    {
      by: 'rider',
      cause: 'start-trip',
      newTrip: true,
      tMs: T('2026-10-26T17:17:00.050Z')
    },
    {
      by: 'app',
      cause: 'quiet-replan-scoped',
      tMs: T('2026-10-26T17:27:09.217Z')
    }
  ]
  const causes = (fixture) =>
    fixture.itinerarySwaps.map(({ itinerary, ...rest }) => rest)

  it('a new build records them', () => {
    const out = path.join(dir, 'built.json')
    execFileSync(
      process.execPath,
      [BUILDER, '--session', SESSION, '--logs-dir', dir, '--out', out],
      { encoding: 'utf8' }
    )
    expect(causes(JSON.parse(fs.readFileSync(out, 'utf8')))).toEqual(expected)
  })

  it('--annotate-swaps writes them into a fixture cut before, and nothing else', () => {
    const before = {
      gpsTrack: [{ lat: 44.916, lon: -93.2622, tMs: 1 }],
      itinerary: plan('1:1', '2026-10-26T17:14:00.795Z'),
      itinerarySwaps: expected.map(({ tMs }) => ({
        itinerary: plan('1:2', '2026-10-26T17:14:00.795Z'),
        tMs
      })),
      meta: { session: SESSION, startMs: T('2026-10-26T17:14:00.795Z') }
    }
    const fixturePath = path.join(dir, 'old.json')
    const out = path.join(dir, 'annotated.json')
    fs.writeFileSync(fixturePath, JSON.stringify(before, null, 2) + '\n')
    execFileSync(
      process.execPath,
      [
        BUILDER,
        '--annotate-swaps',
        fixturePath,
        '--logs-dir',
        dir,
        '--out',
        out
      ],
      { encoding: 'utf8' }
    )
    const after = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(causes(after)).toEqual(expected)
    // The source fixture is untouched when --out is given...
    expect(JSON.parse(fs.readFileSync(fixturePath, 'utf8'))).toEqual(before)
    // ...and the copy differs from it in the annotations alone.
    for (const s of after.itinerarySwaps) {
      delete s.by
      delete s.cause
      delete s.newTrip
    }
    expect(after).toEqual(before)
  })

  it('marks a swap the logs do not hold as unknown, saying why', () => {
    const fixturePath = path.join(dir, 'missing.json')
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        itinerary: plan('1:1', '2026-10-26T17:14:00.795Z'),
        itinerarySwaps: [
          {
            itinerary: plan('1:3', '2026-10-26T17:40:00.000Z'),
            tMs: T('2026-10-26T17:40:00.000Z')
          }
        ],
        meta: { session: SESSION }
      })
    )
    execFileSync(
      process.execPath,
      [BUILDER, '--annotate-swaps', fixturePath, '--logs-dir', dir],
      { encoding: 'utf8' }
    )
    const after = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
    expect(after.itinerarySwaps[0]).toMatchObject({
      by: 'unknown',
      cause: 'not-in-log'
    })
  })
})
