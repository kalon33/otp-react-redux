import type { Leg } from '@opentripplanner/types'

import { asContinuation } from './turn-by-turn'
import type { TripProgress } from './progress-calculator'

/**
 * The sticky per-turn card: ONE notification (fixed id, so iOS replaces it in
 * place rather than stacking), posted when a turn becomes current and held
 * unchanged until the rider passes it — then swapped for the next turn. It
 * carries the instruction only, no live distance: the smooth countdown lives on
 * the phone screen (WalkingNavigation), while the wrist wants a stable "what's
 * my next move" glance that doesn't churn. Passive, because the turns that
 * deserve a buzz already went out as TURN_ALERT.
 *
 * This reaches any paired watch over ANCS — see native-notify.ts.
 *
 * The decision used to be inline in handlePositionUpdate, which meant the only
 * way to exercise it was to run the app against a live OTP backend. It is the
 * same decide/apply split pacing-card.ts already uses: pure in, intent out, the
 * thunk does the pushing.
 */

export interface TurnCardPost {
  message: string
  passive: boolean
  title: string
}

export interface TurnCardDecision {
  /** True when the card on the wrist should be cancelled. */
  clear: boolean
  /** The card key to carry into the next tick (null = no card showing). */
  next: string | null
  /** The card to post, or null to leave the wrist alone. */
  post: TurnCardPost | null
}

/**
 * Decide what the turn card should do this tick.
 *
 * `prev` is the key of the turn currently on the card. Keying on the cue's
 * identity (leg + index) rather than its distance is what makes this write
 * about once per turn instead of once per GPS tick — the 7/31 ride pushed the
 * same "Turn right on Village Lane" 14 times in 7 minutes when the equivalent
 * announcement path had no such latch.
 */
export function evaluateTurnCard(
  prev: string | null,
  input: {
    currentLeg: Leg | undefined
    /** False while replaying, or when config.goMode.turnCard is off. */
    enabled: boolean
    progress: TripProgress
  }
): TurnCardDecision {
  const { currentLeg, enabled, progress } = input

  // Disabled means untouched — not cleared. A replay must not cancel a card
  // the live trip put on the rider's wrist.
  if (!enabled) return { clear: false, next: prev, post: null }

  const cue = progress.nextTurnCue
  if (cue) {
    const cardKey = `${currentLeg?.startTime}_${cue.index}`
    // Same turn as last tick: the card on the wrist is already right.
    if (cardKey === prev) return { clear: false, next: prev, post: null }

    const then = progress.followingTurnCue
      ? `then ${asContinuation(progress.followingTurnCue.instruction)}`
      : ''
    return {
      clear: false,
      next: cardKey,
      post: { message: then, passive: true, title: cue.instruction }
    }
  }

  if (prev === null) return { clear: false, next: null, post: null }

  // No turn to show anymore (boarded a bus, or trip ended). Clear the stale
  // card so the wrist stops displaying a turn that no longer holds.
  //
  // While DEVIATED on an access leg, freeze instead: on 7/29 the rider's
  // perpendicular distance flapped around the 100 m on-route threshold for two
  // minutes, and clearing on each off-route tick would churn cancel→repost on
  // the wrist. The frozen turn is still the rider's last known move; boarding,
  // trip end and genuine on-route cue exhaustion all still clear it.
  const frozen =
    progress.status === 'deviated' &&
    (currentLeg?.mode === 'WALK' || currentLeg?.mode === 'BICYCLE')
  if (frozen) return { clear: false, next: prev, post: null }

  return { clear: true, next: null, post: null }
}
