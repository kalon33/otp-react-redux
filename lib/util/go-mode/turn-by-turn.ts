import { humanizeDistanceStringImperial } from '@opentripplanner/humanize-distance'
import type { LatLngArray, Leg, Step } from '@opentripplanner/types'

import {
  calculateCumulativeDistances,
  decodeLegGeometry,
  projectPointOntoSegment
} from './position-matching'

/**
 * turn-by-turn.ts — real navigation cues for access (walk/bike) legs.
 *
 * OTP hands us `leg.steps`, but each step only knows its own length and the
 * lat/lon where it BEGINS — not where it sits along the leg. Progress, on the
 * other hand, arrives from position-matching as a 0-1 fraction along the leg's
 * decoded polyline. Bridging the two is the whole job here: project every
 * step's start point onto that polyline to learn its offset in metres, and the
 * distance to the next turn becomes plain subtraction on every GPS tick.
 *
 * Summing `step.distance` instead would be cheaper but wrong — the steps of a
 * leg don't always tile it exactly (OTP trims and merges around vertices), so
 * the running total drifts from the polyline the rider is actually matched
 * against, and the drift lands squarely on the turn you're about to miss.
 */

/** A single actionable turn along an access leg. */
export interface StepCue {
  /** Length of the step that STARTS at this turn, in metres. */
  distanceMeters: number
  /** Position in the leg's cue list. */
  index: number
  /** Rider-facing phrasing, e.g. "Turn left on Bryant Ave S". */
  instruction: string
  /** Offset along the leg polyline where the turn happens, in metres. */
  offsetMeters: number
  relativeDirection: string
  /**
   * Whether this turn is worth a buzz on the rider's wrist. See
   * `markSignificance` — a Garmin cannot vary its haptic per notification, so
   * the only lever for "don't buzz me every turn" is not sending most of them.
   */
  significant: boolean
  streetName: string
}

export interface NextCueResult {
  /** The turn to announce now. */
  cue?: StepCue
  /** Metres from the rider's current position to `cue`. */
  distanceToNextTurn?: number
  /** The one after it, for a "then …" line. */
  following?: StepCue
}

/**
 * Directions that describe *staying on the current path* rather than making a
 * decision. OTP emits these liberally — a street that bends, a name change at a
 * municipal boundary — and announcing them would bury the real turns.
 */
const NON_TURN_DIRECTIONS = new Set(['CONTINUE', 'DEPART'])

const DIRECTION_VERBS: Record<string, string> = {
  CIRCLE_CLOCKWISE: 'Take the roundabout',
  CIRCLE_COUNTERCLOCKWISE: 'Take the roundabout',
  ELEVATOR: 'Take the elevator',
  ENTER_STATION: 'Enter the station',
  EXIT_STATION: 'Exit the station',
  FOLLOW_SIGNS: 'Follow signs',
  HARD_LEFT: 'Sharp left',
  HARD_RIGHT: 'Sharp right',
  LEFT: 'Turn left',
  RIGHT: 'Turn right',
  SLIGHTLY_LEFT: 'Bear left',
  SLIGHTLY_RIGHT: 'Bear right',
  UTURN_LEFT: 'U-turn',
  UTURN_RIGHT: 'U-turn'
}

/**
 * A turn preceded by this much uninterrupted travel is worth a buzz: the rider
 * has had time to stop thinking about navigation and put the phone away.
 */
const SIGNIFICANT_GAP_METERS = 400
/** …and the same idea in time, so a slow walk isn't held to a cyclist's metres. */
const SIGNIFICANT_GAP_SECONDS = 90

/** Fallback speed when a leg lacks usable duration/distance, in m/s (~4 mph). */
const FALLBACK_SPEED_MPS = 1.8

/** Rider-facing phrasing for a step. Exported for tests and UI reuse. */
export function phraseInstruction(step: Step): string {
  const verb = DIRECTION_VERBS[step.relativeDirection]
  // `bogusName` marks a way OTP couldn't name ("path", "road"); naming it adds
  // nothing the rider can see from the saddle, so drop it.
  const street = step.bogusName ? '' : (step.streetName || '').trim()

  if (!verb) {
    // Unknown or non-turn direction — describe the street if we have one.
    return street ? `Continue on ${street}` : 'Continue'
  }
  return street ? `${verb} on ${street}` : verb
}

/**
 * An instruction reworded to sit mid-sentence, after "then". Instructions lead
 * with a capitalised verb, which reads as a typo once embedded ("then Turn
 * right on Oak").
 */
export function asContinuation(instruction: string): string {
  return instruction.charAt(0).toLowerCase() + instruction.slice(1)
}

/** Abbreviated imperial distance ("300 ft", "0.4 mi") for cue copy. */
export function formatCueDistance(meters: number): string {
  return humanizeDistanceStringImperial(meters, true)
}

/**
 * Offset in metres along `polyline` of the point nearest to `point`.
 *
 * Steps sit ON the leg geometry in principle, but OTP rounds step coordinates
 * to fewer decimal places than the encoded polyline, so an exact vertex match
 * can't be assumed — project and take the best segment.
 */
function offsetAlongPolyline(
  polyline: LatLngArray[],
  cumulative: number[],
  point: LatLngArray
): number {
  let bestOffset = 0
  let bestPerp = Infinity

  for (let i = 0; i < polyline.length - 1; i++) {
    const projection = projectPointOntoSegment(
      point,
      polyline[i],
      polyline[i + 1]
    )
    if (projection.perpDistance < bestPerp) {
      bestPerp = projection.perpDistance
      const segmentLength = cumulative[i + 1] - cumulative[i]
      bestOffset = cumulative[i] + segmentLength * projection.alongSegment
    }
  }

  return bestOffset
}

/**
 * Flag the turns worth interrupting the rider for: the first one of the leg
 * (they're just setting off), the last one (the final approach), and any turn
 * that follows a long enough stretch of not having to think.
 *
 * Everything else stays silent and only updates the on-screen / always-current
 * card. Dense downtown grids can put turns 80 m apart; buzzing each one is how
 * a rider learns to ignore the watch.
 */
function markSignificance(cues: StepCue[], speedMps: number): void {
  cues.forEach((cue, i) => {
    if (i === 0 || i === cues.length - 1) {
      cue.significant = true
      return
    }
    const gapMeters = cue.offsetMeters - cues[i - 1].offsetMeters
    cue.significant =
      gapMeters > SIGNIFICANT_GAP_METERS ||
      gapMeters / speedMps > SIGNIFICANT_GAP_SECONDS
  })
}

interface LegCues {
  cues: StepCue[]
  legLength: number
}

// Built cue lists are reused across GPS ticks — decoding the polyline and
// projecting every step once per second would be pure waste. Keyed on the leg
// object, which is stable for the life of an itinerary and collectable once
// it's swapped out.
const cueCache = new WeakMap<Leg, LegCues>()

function buildLegCues(leg: Leg): LegCues {
  const cached = cueCache.get(leg)
  if (cached) return cached

  const steps = leg?.steps
  const polyline = decodeLegGeometry(leg)
  if (!steps?.length || polyline.length < 2) {
    const empty = { cues: [], legLength: 0 }
    cueCache.set(leg, empty)
    return empty
  }

  const cumulative = calculateCumulativeDistances(polyline)
  const legLength = cumulative[cumulative.length - 1] || 0

  const cues: StepCue[] = []
  steps.forEach((step) => {
    const isTurn =
      !NON_TURN_DIRECTIONS.has(step.relativeDirection) && !step.stayOn
    if (!isTurn) {
      // Not a decision point. Its distance still belongs to the rider's current
      // stretch, so fold it into the cue they're already following rather than
      // dropping it — otherwise "then in 0.3 mi" under-reports.
      const previous = cues[cues.length - 1]
      if (previous) previous.distanceMeters += step.distance || 0
      return
    }

    cues.push({
      distanceMeters: step.distance || 0,
      index: cues.length,
      instruction: phraseInstruction(step),
      offsetMeters: offsetAlongPolyline(polyline, cumulative, [
        step.lat,
        step.lon
      ]),
      relativeDirection: step.relativeDirection,
      significant: false,
      streetName: step.streetName
    })
  })

  const legSeconds = leg.duration || 0
  const legMeters = leg.distance || legLength
  const speedMps =
    legSeconds > 0 && legMeters > 0
      ? legMeters / legSeconds
      : FALLBACK_SPEED_MPS

  markSignificance(cues, speedMps)

  const built = { cues, legLength }
  cueCache.set(leg, built)
  return built
}

/**
 * Build the ordered turn list for an access leg. Returns [] when the leg has no
 * usable steps or geometry — callers fall back to destination-only guidance.
 */
export function buildStepIndex(leg: Leg): StepCue[] {
  return buildLegCues(leg).cues
}

/**
 * The turn to announce for a rider `progressAlongLeg` (0-1) into `leg`, plus
 * the one after it. Returns {} when the leg has no cues left to give.
 */
export function getNextCue(leg: Leg, progressAlongLeg: number): NextCueResult {
  const { cues, legLength } = buildLegCues(leg)
  if (!cues.length) return {}

  const currentOffset = Math.max(0, Math.min(1, progressAlongLeg)) * legLength

  // First cue the rider hasn't reached yet. A small tolerance keeps a turn from
  // flickering back as the announced one when GPS noise nudges progress
  // backwards across the vertex.
  const cue = cues.find((c) => c.offsetMeters > currentOffset + 5)
  if (!cue) return {}

  return {
    cue,
    distanceToNextTurn: cue.offsetMeters - currentOffset,
    following: cues[cue.index + 1]
  }
}
