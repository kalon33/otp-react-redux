import { classifyBuffer } from './pacing-card'
import type { NotificationEvent } from './notification-service'

/**
 * departure-drift.ts — watch the boarding you're travelling toward and say so
 * when it moves.
 *
 * The plan's board time never changes, and the auto-anchor
 * (departure-anchor.ts) only ever moves EARLIER, by design. So a bus that slips
 * six minutes while the rider is on their way used to be invisible: the wait
 * math, the pacing card and the "time to go" alert all ran on a departure that
 * had stopped being true. Requested after the 8/9 ride: track the arrival time
 * for jumps against the initial estimate, and when it moves, say what changed
 * AND how hard to push on the rest of the approach.
 *
 * The baseline is captured once per boarding and held. Quoting total drift is
 * the point — "6 min later" is actionable in a way that three separate "2 min
 * later" alerts are not — so re-alerts fire on each further ±2 min of movement
 * from the last figure the rider was told, in either direction. A bus that
 * hands back the time it borrowed is news too, and lands as "back on time".
 *
 * Pure: every clock arrives via nowMs, so the cadence is unit-testable.
 */

/** Movement from the last-announced figure worth another alert. */
export const DEPARTURE_DRIFT_ALERT_MS = 120000

/**
 * How far behind the clock a live prediction may sit and still be believed.
 * Deliberately the same 60 s as DEPARTURE_OVERDUE_GRACE_MS: a departure that
 * has just gone by is a bus that may still be pulling in, but one a full minute
 * in the past is either a feed that is lying (8/9: `UPDATED` with
 * `arrivalDelay: 0` on a bus running 11 min late) or a bus that has gone — and
 * whether it has gone is classifyMissedBus's call, never this module's.
 */
export const DEPARTURE_STALE_GRACE_MS = 60000

export interface DepartureBaselineState {
  /** The prediction when this boarding first became current. */
  baselineMs: number
  /** Identity of the boarding — see the boardingKey note in evaluate. */
  boardingKey: string
  /** Signed drift the rider was last told about; 0 = still at the baseline. */
  lastAlertedDriftMs: number
}

export interface DepartureDriftInput {
  /**
   * Identity of the boarding at stake, `${legIndex}:${tripId}:${override}`.
   * Anything that makes this a DIFFERENT departure — the auto-anchor adopting
   * an earlier run, the rider picking another bus, an itinerary swap — changes
   * the key and re-baselines silently, so a swap can never be reported as a
   * jump.
   */
  boardingKey: string | null
  /** Live (realtime-flagged) prediction for that boarding, epoch ms. */
  liveDepartureMs: number | null
  nowMs: number
  routeName: string
  /** progress.waitTimeAtStop — slack once the rider reaches the stop. */
  waitSeconds: number | null | undefined
}

/**
 * The words the rider asked for, from the same three-way split the pacing card
 * buzzes on (classifyBuffer) — so the card's haptics and this sentence can
 * never tell different stories.
 */
export function paceAdvice(waitSeconds: number): string {
  switch (classifyBuffer(waitSeconds)) {
    case 'atRisk':
      return 'hurry'
    case 'tight':
      return 'pick up the pace'
    default:
      return 'take your time'
  }
}

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit'
  })
}

/**
 * "8 min slack at the stop" / "2 min short at the stop" / '' when unknown.
 *
 * Negative waits round AWAY from zero, the same rule the pacing card's copy
 * follows: 30 s short is "1 min short", never a falsely reassuring "0 min
 * slack" (Math.round(-0.5) is -0, which is not < 0).
 */
function slackPhrase(waitSeconds: number | null | undefined): string {
  if (waitSeconds == null) return ''
  const mins =
    waitSeconds < 0
      ? Math.floor(waitSeconds / 60)
      : Math.round(waitSeconds / 60)
  return mins < 0
    ? `${-mins} min short at the stop`
    : `${mins} min slack at the stop`
}

function composeAlert(
  input: DepartureDriftInput,
  driftMs: number,
  departureMs: number
): NotificationEvent {
  const { boardingKey, nowMs, routeName, waitSeconds } = input
  const driftMin = Math.round(driftMs / 60000)
  const change =
    driftMin === 0
      ? 'Back to the original time'
      : `${Math.abs(driftMin)} min ${
          driftMin > 0 ? 'later' : 'earlier'
        } than first estimated`

  const advice = waitSeconds != null ? paceAdvice(waitSeconds) : ''
  const slack = slackPhrase(waitSeconds)
  const tail = [advice, slack].filter(Boolean).join(', ')

  // Losing slack is the case worth a buzz on the wrist; a bus handing time back
  // is good news and arrives without one (showNotification vibrates on 'high'
  // only). Both still reach the phone — the type is in PUSH_NOTIFICATION_TYPES.
  const losingSlack = driftMs < 0 || (waitSeconds != null && waitSeconds < 180)

  return {
    id: `DEPARTURE_CHANGED_${boardingKey}_${nowMs}`,
    message: tail ? `${change} — ${tail}.` : `${change}.`,
    priority: losingSlack ? 'high' : 'medium',
    timestamp: new Date(nowMs),
    title: `${routeName} now ${formatClockTime(departureMs)}`,
    type: 'DEPARTURE_CHANGED'
  }
}

/**
 * Decide whether the departure has moved enough to tell the rider.
 *
 * Returns the baseline to carry forward (null = no boarding to watch) and, when
 * due, the notification. Mirrors evaluatePacingCard's shape deliberately: all
 * cadence in one pure function, none of it in the action layer.
 */
export function evaluateDepartureDrift(
  prev: DepartureBaselineState | null,
  input: DepartureDriftInput
): { alert: NotificationEvent | null; next: DepartureBaselineState | null } {
  const { boardingKey, liveDepartureMs, nowMs } = input
  if (!boardingKey) return { alert: null, next: null }

  // The baseline only counts if it belongs to THIS boarding.
  const baseline = prev?.boardingKey === boardingKey ? prev : null

  // No usable prediction this tick — a realtime dropout, or a value the feed
  // has left behind the clock. Hold the baseline for a boarding still ahead
  // (the next poll may bring the number back); drop one we have moved past.
  const usable =
    liveDepartureMs != null &&
    Number.isFinite(liveDepartureMs) &&
    liveDepartureMs >= nowMs - DEPARTURE_STALE_GRACE_MS
  if (!usable) {
    return { alert: null, next: baseline }
  }

  // First sight of this boarding: record what it said and say nothing. There is
  // nothing to diverge from yet.
  if (!baseline) {
    return {
      alert: null,
      next: { baselineMs: liveDepartureMs, boardingKey, lastAlertedDriftMs: 0 }
    }
  }

  const driftMs = liveDepartureMs - baseline.baselineMs
  // Measured from the figure the rider was last given, not from the baseline:
  // that is what makes a slow slip re-alert at 2, 4, 6 min instead of once, and
  // what lets a recovering bus report its way back.
  if (
    Math.abs(driftMs - baseline.lastAlertedDriftMs) < DEPARTURE_DRIFT_ALERT_MS
  ) {
    return { alert: null, next: baseline }
  }

  return {
    alert: composeAlert(input, driftMs, liveDepartureMs),
    next: { ...baseline, lastAlertedDriftMs: driftMs }
  }
}
