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

const PACE_HINT: Record<PacingState, string> = {
  atRisk: 'go fast — cutting it close',
  comfortable: 'easy pace',
  tight: 'keep moving'
}

function formatClock(epochMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(epochMs))
}

function composePost(
  nextLeg: Leg,
  rideMin: number,
  bufferMin: number,
  state: PacingState,
  departureEpochMs: number,
  passive: boolean
): PacingCardPost {
  const routeName =
    (nextLeg as any).routeShortName ||
    (nextLeg as any).route?.shortName ||
    'Your bus'
  const title =
    state === 'atRisk'
      ? `🚲 Go fast — ${rideMin} min ride, bus at ${formatClock(
          departureEpochMs
        )}`
      : `🚲 ${rideMin} min ride · ${bufferMin} min wait at stop`
  return {
    message: `${routeName} at ${formatClock(departureEpochMs)} — ${
      PACE_HINT[state]
    }`,
    passive,
    priority: state === 'atRisk' ? 1 : 0,
    title
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
  const bufferMin = Math.round(wait / 60)
  const state = classifyBuffer(wait)
  const departureEpochMs = nowMs + due * 1000
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
    post: composePost(
      nextLeg,
      rideMin,
      bufferMin,
      state,
      departureEpochMs,
      passive
    )
  }
}
