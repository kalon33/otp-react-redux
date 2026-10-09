// @ts-expect-error @opentripplanner/icons ships no type declarations
import { DirectionIcon } from '@opentripplanner/icons'
import React from 'react'

import { TurnArrowBox } from './styled'

/**
 * The turn as a picture (backlog 44.3). Rider, 2026-10-08 18:04:32: "visual
 * directions instead of words on the bike routing"; asked arrow, map, or
 * both, the answer was "Both" — this is the arrow on the card.
 *
 * The arrows are @opentripplanner/icons' own direction set, which already
 * ships with the app and mapped OTP's `relativeDirection` one-to-one before
 * this used it. The words stay beside it: the arrow is decorative to a screen
 * reader (aria-hidden), which reads the instruction instead.
 *
 * `ARRIVE` is ours, not OTP's: the last stretch of a leg ("Arriving at …")
 * has no turn, so it gets a destination pin rather than a straight arrow
 * that would say "keep going".
 */
export const ARRIVE_DIRECTION = 'ARRIVE'

/** The directions DirectionIcon draws; anything else renders no arrow. */
const DRAWN = new Set([
  'CIRCLE_CLOCKWISE',
  'CIRCLE_COUNTERCLOCKWISE',
  'CONTINUE',
  'DEPART',
  'ELEVATOR',
  'ENTER_STATION',
  'EXIT_STATION',
  'FOLLOW_SIGNS',
  'HARD_LEFT',
  'HARD_RIGHT',
  'LEFT',
  'RIGHT',
  'SLIGHTLY_LEFT',
  'SLIGHTLY_RIGHT',
  'UTURN_LEFT',
  'UTURN_RIGHT'
])

/** Whether `direction` has an arrow to draw. */
export function hasTurnArrow(direction: string | null | undefined): boolean {
  if (!direction) return false
  const key = direction.toUpperCase()
  return key === ARRIVE_DIRECTION || DRAWN.has(key)
}

// A map pin, same weight as the direction set (solid, single path).
const ArrivePin = () => (
  <svg viewBox="0 0 24 24">
    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z" />
  </svg>
)

const TurnArrow = ({
  direction
}: {
  direction: string | null | undefined
}): JSX.Element | null => {
  if (!direction || !hasTurnArrow(direction)) return null
  const key = direction.toUpperCase()
  return (
    <TurnArrowBox
      aria-hidden
      data-direction={key}
      data-testid="go-mode-turn-arrow"
    >
      {key === ARRIVE_DIRECTION ? (
        <ArrivePin />
      ) : (
        <DirectionIcon relativeDirection={key} />
      )}
    </TurnArrowBox>
  )
}

export default TurnArrow
