import { encode } from '@mapbox/polyline'

import {
  buildStepIndex,
  formatCueDistance,
  getNextCue,
  phraseInstruction,
  selectCueForNavigation
} from '../../../lib/util/go-mode/turn-by-turn'

// A straight run due north from a point in south Minneapolis. 0.0009° of
// latitude is ~100 m, so vertex i sits ~100i metres along the leg and cue
// offsets can be asserted directly against the metre marks.
const ORIGIN_LAT = 44.92
const ORIGIN_LON = -93.27
const STEP_DEG = 0.0009
const VERTEX_M = 100.08 // haversine distance of STEP_DEG at this latitude

const vertex = (i: number): [number, number] => [
  ORIGIN_LAT + i * STEP_DEG,
  ORIGIN_LON
]

/** Leg whose geometry runs north through `vertexCount` vertices. */
const makeLeg = (steps: any[], vertexCount = 11, overrides: any = {}) => {
  const points = Array.from({ length: vertexCount }, (_, i) => vertex(i))
  return {
    distance: (vertexCount - 1) * VERTEX_M,
    // ~1000 m at 5 m/s — a plausible bike leg
    duration: ((vertexCount - 1) * VERTEX_M) / 5,
    legGeometry: { length: points.length, points: encode(points, 5) },
    mode: 'BICYCLE',
    steps,
    to: { name: 'Bus Stop' },
    ...overrides
  } as any
}

/** A step beginning at vertex `atVertex`. */
const makeStep = (
  atVertex: number,
  relativeDirection: string,
  streetName: string,
  extra: any = {}
) => {
  const [lat, lon] = vertex(atVertex)
  return {
    area: false,
    bogusName: false,
    distance: 100,
    lat,
    lon,
    relativeDirection,
    stayOn: false,
    streetName,
    ...extra
  }
}

describe('util > go-mode > turn-by-turn', () => {
  describe('phraseInstruction', () => {
    it('joins the direction verb with the street name', () => {
      expect(
        phraseInstruction(makeStep(0, 'LEFT', 'Bryant Ave S') as any)
      ).toBe('Turn left on Bryant Ave S')
      expect(
        phraseInstruction(makeStep(0, 'HARD_RIGHT', 'W 24th St') as any)
      ).toBe('Sharp right on W 24th St')
      expect(
        phraseInstruction(makeStep(0, 'SLIGHTLY_LEFT', 'Greenway') as any)
      ).toBe('Bear left on Greenway')
      expect(
        phraseInstruction(makeStep(0, 'UTURN_RIGHT', 'Lyndale') as any)
      ).toBe('U-turn on Lyndale')
    })

    it('drops names OTP flagged as bogus rather than reading out "path"', () => {
      expect(
        phraseInstruction(
          makeStep(0, 'LEFT', 'path', { bogusName: true }) as any
        )
      ).toBe('Turn left')
    })

    it('falls back to a continue phrasing for unknown directions', () => {
      expect(
        phraseInstruction(makeStep(0, 'CONTINUE', 'Bryant Ave S') as any)
      ).toBe('Continue on Bryant Ave S')
    })
  })

  describe('buildStepIndex', () => {
    it('returns no cues for a leg with no steps', () => {
      expect(buildStepIndex(makeLeg([]))).toEqual([])
    })

    it('returns no cues when the leg has no geometry', () => {
      const leg = makeLeg([makeStep(3, 'LEFT', 'W 24th St')])
      leg.legGeometry = undefined
      expect(buildStepIndex(leg)).toEqual([])
    })

    it('places each turn at its offset along the leg', () => {
      const cues = buildStepIndex(
        makeLeg([
          makeStep(0, 'DEPART', 'Bryant Ave S'),
          makeStep(3, 'LEFT', 'W 24th St'),
          makeStep(7, 'RIGHT', 'Colfax Ave S')
        ])
      )

      expect(cues.map((c) => c.instruction)).toEqual([
        'Turn left on W 24th St',
        'Turn right on Colfax Ave S'
      ])
      expect(cues[0].offsetMeters).toBeCloseTo(3 * VERTEX_M, 0)
      expect(cues[1].offsetMeters).toBeCloseTo(7 * VERTEX_M, 0)
      // DEPART is not a decision point and must not become a cue.
      expect(cues.map((c) => c.relativeDirection)).not.toContain('DEPART')
    })

    it('collapses a stayOn bend into the cue the rider is already following', () => {
      const cues = buildStepIndex(
        makeLeg([
          makeStep(0, 'DEPART', 'Bryant Ave S'),
          makeStep(3, 'LEFT', 'W 24th St', { distance: 100 }),
          // Same street bending; OTP emits a step but there is nothing to do.
          makeStep(5, 'SLIGHTLY_RIGHT', 'W 24th St', {
            distance: 250,
            stayOn: true
          })
        ])
      )

      expect(cues).toHaveLength(1)
      expect(cues[0].instruction).toBe('Turn left on W 24th St')
      // The bend's distance still belongs to this stretch.
      expect(cues[0].distanceMeters).toBe(350)
    })

    it('projects steps whose coordinates sit slightly off the polyline', () => {
      // OTP rounds step coordinates more coarsely than the encoded polyline, so
      // an exact vertex match cannot be assumed.
      const [lat, lon] = vertex(4)
      const drifted = makeStep(4, 'LEFT', 'W 24th St')
      drifted.lat = lat + 0.00002 // ~2 m north
      drifted.lon = lon + 0.00003 // ~2 m east, off the line entirely

      const cues = buildStepIndex(makeLeg([drifted]))
      expect(cues).toHaveLength(1)
      expect(cues[0].offsetMeters).toBeCloseTo(4 * VERTEX_M, -1)
    })

    describe('significance', () => {
      it('always flags the first and last turn of a leg', () => {
        const cues = buildStepIndex(
          makeLeg([
            makeStep(1, 'LEFT', 'A St'),
            makeStep(2, 'RIGHT', 'B St'),
            makeStep(3, 'LEFT', 'C St')
          ])
        )
        expect(cues.map((c) => c.significant)).toEqual([true, false, true])
      })

      it('flags a turn that follows a long uninterrupted stretch', () => {
        // Vertices 1, 2 and 7 → a 500 m gap before the third turn.
        const cues = buildStepIndex(
          makeLeg(
            [
              makeStep(1, 'LEFT', 'A St'),
              makeStep(2, 'RIGHT', 'B St'),
              makeStep(7, 'LEFT', 'C St'),
              makeStep(8, 'RIGHT', 'D St')
            ],
            12
          )
        )
        // Index 1 is 100 m after its predecessor — routine, stays silent.
        expect(cues[1].significant).toBe(false)
        // Index 2 follows 500 m of not having to think.
        expect(cues[2].significant).toBe(true)
      })

      it('flags on elapsed time when a slow leg makes the metre gap small', () => {
        // 200 m gap — under the 400 m rule — but at walking pace it is well
        // over the 90 s rule, so the rider has still stopped paying attention.
        const cues = buildStepIndex(
          makeLeg(
            [
              makeStep(1, 'LEFT', 'A St'),
              makeStep(3, 'RIGHT', 'B St'),
              makeStep(4, 'LEFT', 'C St')
            ],
            8,
            { distance: 700, duration: 700, mode: 'WALK' } // 1 m/s
          )
        )
        expect(cues[1].significant).toBe(true)
      })
    })
  })

  describe('getNextCue', () => {
    const leg = makeLeg([
      makeStep(0, 'DEPART', 'Bryant Ave S'),
      makeStep(3, 'LEFT', 'W 24th St'),
      makeStep(7, 'RIGHT', 'Colfax Ave S')
    ])

    it('returns nothing for a leg with no cues', () => {
      expect(getNextCue(makeLeg([]), 0.5)).toEqual({})
    })

    it('announces the first turn ahead, with the one after it', () => {
      // 100 m in — 200 m short of the turn at vertex 3.
      const { cue, distanceToNextTurn, following } = getNextCue(leg, 0.1)
      expect(cue!.instruction).toBe('Turn left on W 24th St')
      expect(distanceToNextTurn).toBeCloseTo(2 * VERTEX_M, 0)
      expect(following!.instruction).toBe('Turn right on Colfax Ave S')
    })

    it('advances to the next turn once the first is behind the rider', () => {
      // 400 m in — past vertex 3, short of vertex 7.
      const { cue, distanceToNextTurn, following } = getNextCue(leg, 0.4)
      expect(cue!.instruction).toBe('Turn right on Colfax Ave S')
      expect(distanceToNextTurn).toBeCloseTo(3 * VERTEX_M, 0)
      expect(following).toBeUndefined()
    })

    it('returns nothing once every turn is behind the rider', () => {
      expect(getNextCue(leg, 0.95)).toEqual({})
    })

    it('does not flick back to a passed turn on GPS jitter', () => {
      // Sitting a couple of metres short of the turn must not re-announce it
      // after the rider has already been carried past.
      const justPast = getNextCue(leg, (3 * VERTEX_M + 2) / (10 * VERTEX_M))
      expect(justPast.cue!.instruction).toBe('Turn right on Colfax Ave S')
    })

    it('clamps out-of-range progress instead of running off the leg', () => {
      expect(getNextCue(leg, -0.5).cue!.instruction).toBe(
        'Turn left on W 24th St'
      )
      expect(getNextCue(leg, 1.5)).toEqual({})
    })
  })

  describe('formatCueDistance', () => {
    it('renders abbreviated imperial distances', () => {
      expect(formatCueDistance(30)).toMatch(/ft/)
      expect(formatCueDistance(3000)).toMatch(/mi/)
    })
  })

  describe('selectCueForNavigation', () => {
    // A 2000 m leg with turns at ~300, ~700 and ~1500 m. Each test makes a
    // fresh leg object: the per-leg cursor is keyed on leg identity, exactly
    // like the post-replan reset it models.
    const makeNavLeg = () =>
      makeLeg(
        [
          makeStep(0, 'DEPART', 'Bryant Ave S'),
          makeStep(3, 'LEFT', 'W 24th St'),
          makeStep(7, 'RIGHT', 'Colfax Ave S'),
          makeStep(15, 'LEFT', 'E 46th St')
        ],
        21
      )
    // Progress fraction for a metre offset on that 2000 m leg.
    const at = (meters: number) => meters / (20 * VERTEX_M)

    // A point `eastM` metres east of the leg's line, level with vertex
    // `latVertex` — i.e. a rider on a parallel street.
    const beside = (latVertex: number, eastM: number): [number, number] => [
      ORIGIN_LAT + latVertex * STEP_DEG,
      ORIGIN_LON + eastM / (111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180))
    ]

    it('returns no cue off the route when the caller gives no position', () => {
      const leg = makeNavLeg()
      // The projection says ~40% along, but the rider is not on the route —
      // that projection is a fiction (7/29: it swept past three real turns).
      // Without the rider's own fix there is nothing honest to measure with,
      // so callers that pass none keep the old silence.
      expect(selectCueForNavigation(leg, at(800), false)).toEqual({})
    })

    it('holds a turn off the route, measured straight from the rider', () => {
      const leg = makeNavLeg()
      selectCueForNavigation(leg, at(250), true)
      // Off on a parallel street 150 m east, level with vertex 5.5, with the
      // projection dragged to 650 m. The rider is nearer the 700 m turn than
      // the 300 m one they were last given, so that is the turn to hold.
      const off = selectCueForNavigation(leg, at(650), false, beside(5.5, 150))
      expect(off.cue!.instruction).toBe('Turn right on Colfax Ave S')
      expect(off.turnDistanceIsDirect).toBe(true)
      // Straight line to the corner (~150 m across, ~150 m up), NOT the 50 m
      // the projection would have claimed.
      expect(off.distanceToNextTurn).toBeGreaterThan(200)
      expect(off.distanceToNextTurn).toBeLessThan(225)
    })

    it('never falls back to a turn given before the excursion', () => {
      const leg = makeNavLeg()
      selectCueForNavigation(leg, at(250), true)
      // The projection stays pinned where the rider left the line (the
      // 2026-09-01 freeze), so the held turn is the one that was current.
      const off = selectCueForNavigation(leg, at(250), false, beside(3.5, 150))
      expect(off.cue!.instruction).toBe('Turn left on W 24th St')
      // …and never the one behind it, however near the rider drifts to it.
      const back = selectCueForNavigation(leg, at(250), false, beside(0, 5))
      expect(back.cue!.instruction).toBe('Turn left on W 24th St')
    })

    it('announces an off-route turn only once the rider is closing on it', () => {
      const leg = makeNavLeg()
      selectCueForNavigation(leg, at(250), true)
      const held = [5.5, 6, 6.5, 7].map(
        (v) =>
          selectCueForNavigation(leg, at(650), false, beside(v, 150))
            .announceHold
      )
      // Three closing ticks of evidence, then the buzz is allowed.
      expect(held).toEqual([true, true, true, false])
    })

    it('stays silent about an off-route turn the rider rides away from', () => {
      const leg = makeNavLeg()
      selectCueForNavigation(leg, at(250), true)
      const held = [7, 6.5, 6, 5.5, 5].map(
        (v) =>
          selectCueForNavigation(leg, at(650), false, beside(v, 150))
            .announceHold
      )
      // The 7/29 complaint, verbatim: a turn behind the rider never converges,
      // so it is never announced — it just sits on the card.
      expect(held).toEqual([true, true, true, true, true])
    })

    it('drops a held turn silently when the rejoin lands past it', () => {
      const leg = makeNavLeg()
      const surfaced: string[] = []
      const record = (r: ReturnType<typeof selectCueForNavigation>) => {
        if (r.cue) surfaced.push(r.cue.instruction)
        return r
      }
      record(selectCueForNavigation(leg, at(250), true))
      for (const v of [5.5, 6, 6.5, 7]) {
        record(selectCueForNavigation(leg, at(650), false, beside(v, 150)))
      }
      // Back on the line at 800 m: the 700 m turn is behind the rider, taken
      // a block early. It must go without a word — never re-offered as next.
      const rejoin = record(
        selectCueForNavigation(leg, at(800), true, beside(8, 2))
      )
      expect(rejoin.cue!.instruction).toBe('Turn left on E 46th St')
      expect(rejoin.turnDistanceIsDirect).toBeFalsy()
      const after = record(
        selectCueForNavigation(leg, at(850), true, beside(8.5, 2))
      )
      expect(after.cue!.instruction).toBe('Turn left on E 46th St')
      expect(surfaced.slice(-2)).toEqual([
        'Turn left on E 46th St',
        'Turn left on E 46th St'
      ])
    })

    it('matches getNextCue exactly on plausible on-route ticks, no hold', () => {
      const leg = makeNavLeg()
      for (const m of [100, 150, 200, 250]) {
        const result = selectCueForNavigation(leg, at(m), true)
        expect(result.announceHold).toBeFalsy()
        expect(result.cue).toEqual(getNextCue(leg, at(m)).cue)
        expect(result.distanceToNextTurn).toEqual(
          getNextCue(leg, at(m)).distanceToNextTurn
        )
      }
    })

    it('holds announcements for two plausible ticks after a rejoin', () => {
      const leg = makeNavLeg()
      selectCueForNavigation(leg, at(100), true)
      // Off on a parallel street for a while.
      selectCueForNavigation(leg, at(400), false)
      selectCueForNavigation(leg, at(600), false)
      // Rejoin: the cue is correct immediately, but announcements hold.
      const rejoin = selectCueForNavigation(leg, at(750), true)
      expect(rejoin.cue!.instruction).toBe('Turn left on E 46th St')
      expect(rejoin.announceHold).toBe(true)
      const settling = selectCueForNavigation(leg, at(760), true)
      expect(settling.announceHold).toBe(true)
      // Second consecutive plausible advance: announcements resume.
      const settled = selectCueForNavigation(leg, at(770), true)
      expect(settled.announceHold).toBeFalsy()
      expect(settled.cue!.instruction).toBe('Turn left on E 46th St')
    })

    it('holds on a >100 m single-tick jump and never surfaces skipped cues', () => {
      const leg = makeNavLeg()
      const surfaced: string[] = []
      const record = (r: ReturnType<typeof selectCueForNavigation>) => {
        if (r.cue) surfaced.push(r.cue.instruction)
        return r
      }
      record(selectCueForNavigation(leg, at(100), true))
      record(selectCueForNavigation(leg, at(150), true))
      // The projection leaps 650 m in one nominally on-route tick — a rider
      // cannot move that far between fixes; this is the 7/29 sweep.
      const jump = record(selectCueForNavigation(leg, at(800), true))
      expect(jump.announceHold).toBe(true)
      record(selectCueForNavigation(leg, at(810), true))
      const settled = record(selectCueForNavigation(leg, at(820), true))
      expect(settled.announceHold).toBeFalsy()
      // The turn at ~700 m was swept past and must never have become current.
      expect(surfaced).not.toContain('Turn right on Colfax Ave S')
    })

    it('does not hold on an on-route backtrack and re-serves the earlier cue', () => {
      const leg = makeNavLeg()
      selectCueForNavigation(leg, at(400), true)
      selectCueForNavigation(leg, at(500), true)
      // The 7/29 track's own min 9–12: rode out, turned around, came home.
      const back = selectCueForNavigation(leg, at(200), true)
      expect(back.announceHold).toBeFalsy()
      expect(back.cue!.instruction).toBe('Turn left on W 24th St')
    })

    it('starts clean on a fresh leg object (post-replan)', () => {
      const first = makeNavLeg()
      selectCueForNavigation(first, at(100), false)
      // The quiet replan hands back a NEW leg from the rider's real position;
      // its first tick may announce straight away.
      const fresh = makeNavLeg()
      const result = selectCueForNavigation(fresh, at(100), true)
      expect(result.announceHold).toBeFalsy()
      expect(result.cue!.instruction).toBe('Turn left on W 24th St')
    })
  })
})

/**
 * Backlog 6.7 — the connector turns that made the 2026-09-01 legs shout.
 *
 * OTP names the eight-metre jog between two ways as a full step with its own
 * relativeDirection, and every one of them became a turn cue with a prepare
 * card and an act card. The 10:34 leg's steps, verbatim from that ride's
 * START_GO_MODE payload:
 *
 *   DEPART sidewalk                       8.2 m
 *   RIGHT  Elliot Avenue                 13.3 m
 *   RIGHT  East Minnehaha Parkway       108.0 m
 *   LEFT   Chicago Avenue                 8.5 m
 *   RIGHT  Minnehaha Parkway Trail      224.1 m
 *
 * Four cues for two junctions, and the rider got three announcements in eleven
 * seconds (10:34:24, 10:34:27, 10:34:35).
 */
describe('util > go-mode > turn-by-turn > connector turns (6.7)', () => {
  it('announces the manoeuvre, not the eight-metre jog into it', () => {
    const leg = makeLeg([
      makeStep(0, 'DEPART', 'sidewalk', { distance: 8.2 }),
      makeStep(1, 'RIGHT', 'Elliot Avenue', { distance: 13.3 }),
      makeStep(2, 'RIGHT', 'East Minnehaha Parkway', { distance: 108 }),
      makeStep(3, 'LEFT', 'Chicago Avenue', { distance: 8.5 }),
      makeStep(4, 'RIGHT', 'Minnehaha Parkway Regional Trail', {
        distance: 224.1
      })
    ])
    expect(buildStepIndex(leg).map((c) => c.instruction)).toEqual([
      'Turn right on East Minnehaha Parkway',
      'Turn right on Minnehaha Parkway Regional Trail'
    ])
  })

  it('keeps the indexes contiguous — they key the per-turn latch', () => {
    const leg = makeLeg([
      makeStep(0, 'DEPART', 'sidewalk', { distance: 15.2 }),
      makeStep(1, 'RIGHT', 'service road', { distance: 7.8 }),
      makeStep(2, 'LEFT', 'East 48th Street', { distance: 220.1 }),
      makeStep(3, 'RIGHT', 'Park Avenue', { distance: 401.7 })
    ])
    expect(buildStepIndex(leg).map((c) => c.index)).toEqual([0, 1])
  })

  it('never folds the last turn away — it is the way into the block', () => {
    // 2026-09-01 10:33: the leg ends `LEFT path 52.9 m`, `LEFT path 9.1 m`.
    // The 9.1 m one is the rider's own driveway and the only thing left to say.
    const leg = makeLeg([
      makeStep(0, 'DEPART', 'sidewalk', { distance: 81.6 }),
      makeStep(1, 'RIGHT', '2nd Avenue South', { distance: 191.1 }),
      makeStep(2, 'LEFT', 'path', { distance: 52.9 }),
      makeStep(3, 'LEFT', 'path', { distance: 9.1 })
    ])
    expect(buildStepIndex(leg)).toHaveLength(3)
  })

  it('gives the folded distance to the cue the rider is following', () => {
    // "then in 0.3 mi" must not under-report because a connector vanished.
    const leg = makeLeg([
      makeStep(0, 'DEPART', 'sidewalk', { distance: 20 }),
      makeStep(1, 'LEFT', 'Park Avenue', { distance: 400 }),
      makeStep(2, 'RIGHT', 'service road', { distance: 10 }),
      makeStep(3, 'LEFT', 'West 105th Street', { distance: 579 })
    ])
    const cues = buildStepIndex(leg)
    expect(cues.map((c) => c.instruction)).toEqual([
      'Turn left on Park Avenue',
      'Turn left on West 105th Street'
    ])
    expect(cues[0].distanceMeters).toBe(410)
  })
})
