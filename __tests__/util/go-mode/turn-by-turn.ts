import { encode } from '@mapbox/polyline'

import {
  buildStepIndex,
  formatCueDistance,
  getNextCue,
  phraseInstruction
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
})
