import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from './progress-calculator'

/**
 * The sticky bike-pacing card: one notification (stable id, so iOS replaces it
 * in place) that rides on the wrist during a BICYCLE access leg and answers
 * "should I go fast or slow?" — time left riding, the bus being chased, and
 * the buffer at the stop. Requested on the 7/22 ride: "how much time is left
 * on my bike ride and how much I'll have to wait at the stop … so I can know
 * if I should go Fast or slow."
 *
 * Cadence is deliberately gentle: post once when the leg becomes current,
 * then re-post only when the buffer moves ≥2 min or crosses a pacing edge
 * (comfortable ↔ tight ↔ at-risk), never more than once per 90 s — except a
 * WORSENING edge, which may not wait. Only the initial post and worsening
 * edges alert (wrist buzz); everything else is a passive in-place update, the
 * same split the turn card uses.
 */

/** Stable id — see TURN_CARD_NOTIFICATION_ID (=1) for why small ints are safe. */
export const PACING_CARD_NOTIFICATION_ID = 2

export type PacingState = 'atRisk' | 'comfortable' | 'tight'

export interface PacingCardState {
  bufferMin: number
  legKey: string
  postedAtMs: number
  state: PacingState
}

export interface PacingCardPost {
  message: string
  passive: boolean
  priority?: number
  title: string
}

// Under this much slack at the stop the rider should hurry.
const TIGHT_BUFFER_SECONDS = 180
// Floor between re-posts, so a buffer oscillating on GPS noise can't churn
// the wrist. A worsening pacing edge overrides it — "go fast" can't wait.
const MIN_REPOST_INTERVAL_MS = 90000
// Passive re-post when the buffer has moved this much since the last post.
const REPOST_BUFFER_DELTA_MIN = 2

const SEVERITY: Record<PacingState, number> = {
  atRisk: 2,
  comfortable: 0,
  tight: 1
}

export function classifyBuffer(waitSeconds: number): PacingState {
  if (waitSeconds < 0) return 'atRisk'
  if (waitSeconds < TIGHT_BUFFER_SECONDS) return 'tight'
  return 'comfortable'
}

// Rider-confirmed copy: ride time left and projected wait, NOTHING else. A
// negative wait shows with its minus sign — "−2 min wait" says everything
// "go fast" did without adding words. Urgency still arrives as the buzz on a
// worsening pacing edge; the glance stays two numbers.
function composePost(
  rideMin: number,
  bufferMin: number,
  state: PacingState,
  passive: boolean
): PacingCardPost {
  const wait = bufferMin < 0 ? `−${-bufferMin}` : `${bufferMin}`
  return {
    message: '',
    passive,
    priority: state === 'atRisk' ? 1 : 0,
    title: `🚲 ${rideMin} min ride · ${wait} min wait`
  }
}

/**
 * Decide whether the pacing card should (re)post this tick.
 *
 * Returns the card state to carry forward (null = no card should be showing;
 * the caller cancels the notification) and, when due, the notification to
 * post. Pure — all clocks come in via nowMs, so the cadence is unit-testable.
 */
export function evaluatePacingCard(
  prev: PacingCardState | null,
  input: {
    currentLeg: Leg | undefined
    nextLeg: Leg | undefined
    nowMs: number
    progress: TripProgress
  }
): { next: PacingCardState | null; post: PacingCardPost | null } {
  const { currentLeg, nextLeg, nowMs, progress } = input
  const wait = progress.waitTimeAtStop
  const due = progress.timeUntilNextDeparture

  if (
    currentLeg?.mode !== 'BICYCLE' ||
    !nextLeg?.transitLeg ||
    wait == null ||
    due == null
  ) {
    return { next: null, post: null }
  }

  const rideMin = Math.max(0, Math.round((due - wait) / 60))
  // Negative waits round AWAY from zero: 30 s short is "−1 min wait", never a
  // false "0 min wait".
  const bufferMin = wait < 0 ? Math.floor(wait / 60) : Math.round(wait / 60)
  const state = classifyBuffer(wait)
  const legKey = String(currentLeg.startTime)

  const freshLeg = !prev || prev.legKey !== legKey
  const worsened = !freshLeg && SEVERITY[state] > SEVERITY[prev.state]
  const intervalOk =
    !freshLeg && nowMs - prev.postedAtMs >= MIN_REPOST_INTERVAL_MS
  const changedEnough =
    !freshLeg &&
    (state !== prev.state ||
      Math.abs(bufferMin - prev.bufferMin) >= REPOST_BUFFER_DELTA_MIN)

  if (!freshLeg && !worsened && !(intervalOk && changedEnough)) {
    return { next: prev, post: null }
  }

  // The initial post and worsening edges alert; everything else updates the
  // existing wrist entry silently.
  const passive = !freshLeg && !worsened
  return {
    next: { bufferMin, legKey, postedAtMs: nowMs, state },
    post: composePost(rideMin, bufferMin, state, passive)
  }
}
