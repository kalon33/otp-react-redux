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

/**
 * A turn you leave again almost immediately is not a decision — it is the shape
 * of a kerb cut, a driveway apron or an alley mouth, and OTP emits it as a full
 * step with its own name.
 *
 * The 2026-09-01 rides are full of them: `RIGHT service road 7.8 m`,
 * `LEFT Chicago Avenue 8.5 m`, `RIGHT Elliot Avenue 13.3 m`,
 * `LEFT service road 13.6 m`, `LEFT path 9.1 m` (three times). Each one earned
 * its own prepare card and its own act card, so the 10:34 leg spent three
 * announcements in eleven seconds (10:34:24, 10:34:27, 10:34:35) on two jogs
 * around one junction. The rider cannot miss an eight-metre connector; they can
 * only be interrupted by it.
 *
 * So a turn whose own stretch is shorter than this is folded away and the turn
 * AFTER it is announced instead — which is the manoeuvre the rider actually has
 * to steer. Its distance is folded into the previous cue, exactly as a
 * CONTINUE step already is, so "then in 0.3 mi" stays honest.
 *
 * 20 m is deliberately mild: the shortest real turn across those three rides is
 * a 52.9 m path segment, and the alley the rider ends on is 81.2 m. Nothing a
 * rider steers by is anywhere near this line.
 */
export const MICRO_STEP_METERS = 20

/**
 * Drop the connector turns described above, in place.
 *
 * The LAST cue of a leg is never dropped however short it is: it is the final
 * approach, the one turn with nothing after it to announce instead. On the
 * 2026-09-01 10:33 leg that is `LEFT path 9.1 m` — the way into the rider's own
 * block.
 */
function foldMicroSteps(cues: StepCue[]): StepCue[] {
  const kept: StepCue[] = []
  cues.forEach((cue, i) => {
    const isLast = i === cues.length - 1
    if (!isLast && cue.distanceMeters < MICRO_STEP_METERS) {
      const previous = kept[kept.length - 1]
      if (previous) previous.distanceMeters += cue.distanceMeters
      return
    }
    kept.push(cue)
  })
  // The index is the cue's position in the announced list — it keys the
  // per-turn announcement latch and the sticky card — so it has to follow the
  // list it now belongs to, not the one it was built from.
  kept.forEach((cue, i) => {
    cue.index = i
  })
  return kept
}

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

  const raw: StepCue[] = []
  steps.forEach((step) => {
    const isTurn =
      !NON_TURN_DIRECTIONS.has(step.relativeDirection) && !step.stayOn
    if (!isTurn) {
      // Not a decision point. Its distance still belongs to the rider's current
      // stretch, so fold it into the cue they're already following rather than
      // dropping it — otherwise "then in 0.3 mi" under-reports.
      const previous = raw[raw.length - 1]
      if (previous) previous.distanceMeters += step.distance || 0
      return
    }

    raw.push({
      distanceMeters: step.distance || 0,
      index: raw.length,
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

  // Fold the connector turns away BEFORE significance is judged: significance
  // is about the gap the rider has just ridden without thinking, and a 8 m jog
  // that is never announced must not break that gap in two.
  const cues = foldMicroSteps(raw)

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

/**
 * A 1 Hz fix at bike speed advances the projection ≤ ~10 m; 100 m in a single
 * tick is the projection jumping (an off-route rider being dragged along the
 * polyline), not riding. Also safely above verify-turn-by-turn's ~32 m/tick
 * sample spacing, so the verify ride never trips it.
 */
const MAX_TICK_ADVANCE_M = 100
/**
 * Consecutive plausible-advance ticks required before turn announcements
 * resume after a rejoin or a projection jump. Tick-based rather than
 * wall-clock so live 1 Hz GPS, replays and the fast verify loop all behave
 * identically; a backgrounded-GPS gap costs at most this many silent ticks.
 */
const PLAUSIBLE_TICKS_TO_RESUME = 2

interface CueCursor {
  holdTicks: number
  lastOffsetMeters: number | null
  lastOnRoute: boolean
}

// Per-leg navigation state, keyed like cueCache: the leg object is stable for
// the life of an itinerary and collectable once it's swapped out, so a
// post-replan leg is a fresh object and starts with a clean cursor.
const cursorCache = new WeakMap<Leg, CueCursor>()

export interface NavigationCueResult extends NextCueResult {
  /** Hold turn announcements (not the on-screen/wrist cue) this tick. */
  announceHold?: boolean
}

/**
 * `getNextCue` with route honesty. On the 7/29 ride the rider spent two
 * minutes on a street parallel to the bike leg (perpendicular distance
 * flapping around the 100 m on-route threshold) while the nearest-point
 * projection slid 537 m → 1509 m — sweeping straight past the turns at
 * 822/992/1003 m. Every tick that dipped back under the threshold could
 * announce whichever swept-past cue was momentarily "next": "announces turns
 * after you take them", verbatim.
 *
 * So: while `!isOnRoute` the projection is a fiction and no cue is returned at
 * all; and after a rejoin (or a same-tick projection jump bigger than a rider
 * can move) announcements are held for a short settle while the cue itself
 * updates immediately — the screen/wrist shows the correct next turn
 * passively, only the buzz/toast waits. Backwards movement on-route is NOT a
 * jump: the 7/29 track itself contains a legitimate backtrack (min 9–12, the
 * rider rode 500 m out and returned) whose earlier cue must re-announce.
 */
export function selectCueForNavigation(
  leg: Leg,
  progressAlongLeg: number,
  isOnRoute: boolean
): NavigationCueResult {
  const prev = cursorCache.get(leg)

  if (!isOnRoute) {
    cursorCache.set(leg, {
      holdTicks: prev?.holdTicks ?? 0,
      lastOffsetMeters: prev?.lastOffsetMeters ?? null,
      lastOnRoute: false
    })
    return {}
  }

  const { legLength } = buildLegCues(leg)
  const offset = Math.max(0, Math.min(1, progressAlongLeg)) * legLength

  const jumped =
    prev != null &&
    (!prev.lastOnRoute ||
      (prev.lastOffsetMeters != null &&
        offset - prev.lastOffsetMeters > MAX_TICK_ADVANCE_M))

  const holdTicks = jumped
    ? PLAUSIBLE_TICKS_TO_RESUME
    : Math.max(0, (prev?.holdTicks ?? 0) - 1)

  cursorCache.set(leg, {
    holdTicks,
    lastOffsetMeters: offset,
    lastOnRoute: true
  })

  return {
    ...getNextCue(leg, progressAlongLeg),
    announceHold: holdTicks > 0
  }
}
