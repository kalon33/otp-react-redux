import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from './progress-calculator'

/**
 * The sticky pacing card: one notification (stable id, so iOS replaces it in
 * place) that rides on the wrist during an access leg and answers "should I go
 * fast or slow?" — time left travelling, the bus being chased, and the buffer
 * at the stop. Requested on the 7/22 ride: "how much time is left on my bike
 * ride and how much I'll have to wait at the stop … so I can know if I should
 * go Fast or slow."
 *
 * Bike and WALK legs both qualify. The question the card answers is the same
 * one on foot — a walker who can miss a bus by ninety seconds needs to know it
 * as much as a cyclist does — so the only difference is the verb and the icon.
 *
 * Cadence is deliberately gentle: post once when the leg becomes current,
 * then re-post only when the buffer moves ≥2 min or crosses a pacing edge
 * (comfortable ↔ tight ↔ at-risk), never more than once per 90 s — except a
 * WORSENING edge, which may not wait. Only the initial post and worsening
 * edges alert (wrist buzz); everything else is a passive in-place update, the
 * same split the turn card uses.
 *
 * ## The live bike buffer (rider ask, 2026-09-01; backlog 6.10a)
 *
 * "Biking notifications about how much flex or buffer we have after movement
 * is detected on bike legs. Only notify if bus time is live."
 *
 * That is this card, told the truth twice over rather than a second producer
 * buzzing the same wrist. Two of the three numbers change when the evidence
 * is there, and the third — the buzz — is what "only notify if bus time is
 * live" gates:
 *
 *  - the DEPARTURE becomes the feed's prediction, not the timetable's. The
 *    caller passes `liveBoardEpochMs` already gated on `boardRealtime`,
 *    because a board epoch that is NOT realtime has been clamped forward to
 *    `now` (clampNonLiveLegTimes) and would read as a bus perpetually about
 *    to leave;
 *  - the TRAVEL TIME becomes the rider's own: ground still ahead on this leg
 *    divided by the speed they are actually keeping. This is the shape 6.4
 *    built (progress-calculator.ts:218) — the plan's `duration × (1 −
 *    progress)` says nothing about a rider doing 7.7 m/s down a leg planned
 *    at 4.5, which is what 2026-09-01 measured;
 *  - and it only counts once the rider is MOVING. `observedSpeedMps` is the
 *    rolling median from rider-speed.ts, which answers null until eight
 *    moving fixes span a minute of bike leg — so "after movement is detected"
 *    needs no new latch, and there is never a pace to divide by that the
 *    rider did not actually keep.
 *
 * Without all three the card falls back to the plan-derived wait it has always
 * shown, byte for byte, and keeps its old cadence. The plan wait is not a lie,
 * only a schedule; suppressing the card outright when the feed is quiet would
 * withdraw the 7/22 ask to satisfy the 9/01 one.
 */

/** Stable id — see TURN_CARD_NOTIFICATION_ID (=1) for why small ints are safe. */
export const PACING_CARD_NOTIFICATION_ID = 2

export type PacingState = 'atRisk' | 'comfortable' | 'tight'

export interface PacingCardState {
  bufferMin: number
  legKey: string
  /**
   * True when bufferMin was measured against the feed's own departure and the
   * rider's observed pace. Carried so a live buffer is only ever compared with
   * another live one — a plan-derived number and a live one differing by two
   * minutes is a change of evidence, not news about the trip.
   */
  live: boolean
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
// Also the step at which a LIVE buffer that has worsened is allowed to buzz —
// the same hysteresis the delay alert settled on (notification-service.ts), so
// the rider is never buzzed twice about a minute of drift.
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

// Rider-confirmed copy: travel time left and projected wait, NOTHING else. A
// negative wait shows with its minus sign — "−2 min wait" says everything
// "go fast" did without adding words. Urgency still arrives as the buzz on a
// worsening pacing edge; the glance stays two numbers. (The words the rider
// asked for — hurry, take your time — live on the departure-drift alert, which
// fires on a change and has room to explain itself.)
function composePost(
  travelMin: number,
  bufferMin: number,
  state: PacingState,
  passive: boolean,
  walking: boolean
): PacingCardPost {
  const wait = bufferMin < 0 ? `−${-bufferMin}` : `${bufferMin}`
  const icon = walking ? '🚶' : '🚲'
  const verb = walking ? 'walk' : 'ride'
  return {
    message: '',
    passive,
    priority: state === 'atRisk' ? 1 : 0,
    title: `${icon} ${travelMin} min ${verb} · ${wait} min wait`
  }
}

export interface PacingCardDecision {
  /** True when the card on the wrist should be cancelled. */
  clear: boolean
  /** The card state to carry into the next tick (null = no card showing). */
  next: PacingCardState | null
  /** The card to post, or null to leave the wrist alone. */
  post: PacingCardPost | null
}

/**
 * Decide what the pacing card should do this tick.
 *
 * Pure — all clocks come in via nowMs, so the cadence is unit-testable, and
 * the caller only pushes what it is handed. Same shape as evaluateTurnCard.
 */
export function evaluatePacingCard(
  prev: PacingCardState | null,
  input: {
    currentLeg: Leg | undefined
    /** False while replaying, or when config.goMode.pacingCard is off. */
    enabled: boolean
    /**
     * The boarding's live GTFS-realtime departure, ALREADY gated on
     * `boardRealtime` by the caller (see actions/go-mode.ts's liveBoardMs).
     * Absent or null means the feed is not predicting this departure, and the
     * card stays on the plan-derived wait.
     */
    liveBoardEpochMs?: number | null
    nextLeg: Leg | undefined
    nowMs: number
    /**
     * The rider's rolling observed cycling speed in m/s (rider-speed.ts),
     * which is non-null only once they have actually been moving on a bike
     * leg. Absent or null = movement not yet detected.
     */
    observedSpeedMps?: number | null
    progress: TripProgress
  }
): PacingCardDecision {
  const {
    currentLeg,
    enabled,
    liveBoardEpochMs,
    nextLeg,
    nowMs,
    observedSpeedMps,
    progress
  } = input

  // Disabled means untouched — not cleared. A replay must not cancel a card
  // the live trip put on the rider's wrist.
  if (!enabled) return { clear: false, next: prev, post: null }

  const wait = progress.waitTimeAtStop
  const due = progress.timeUntilNextDeparture

  const walking = currentLeg?.mode === 'WALK'
  if (
    (currentLeg?.mode !== 'BICYCLE' && !walking) ||
    !nextLeg?.transitLeg ||
    wait == null ||
    due == null
  ) {
    // Boarded, or the leg no longer leads to transit: drop the card so the
    // wrist stops advising a ride that is over. Nothing to clear if no card
    // was showing.
    return { clear: prev != null, next: null, post: null }
  }

  const flex = measuredFlex({
    currentLeg,
    liveBoardEpochMs,
    nowMs,
    observedSpeedMps,
    progress
  })
  const live = flex != null

  const buffer = flex ? flex.bufferSec : wait
  const travelSec = flex ? flex.travelSec : due - wait
  const travelMin = Math.max(0, Math.round(travelSec / 60))
  // Negative waits round AWAY from zero: 30 s short is "−1 min wait", never a
  // false "0 min wait".
  const bufferMin =
    buffer < 0 ? Math.floor(buffer / 60) : Math.round(buffer / 60)
  const state = classifyBuffer(buffer)
  const legKey = String(currentLeg.startTime)

  const cadence = decideCadence(prev, { bufferMin, legKey, live, nowMs, state })
  if (!cadence.post) return { clear: false, next: prev, post: null }

  return {
    clear: false,
    next: { bufferMin, legKey, live, postedAtMs: nowMs, state },
    post: composePost(travelMin, bufferMin, state, cadence.passive, walking)
  }
}

/**
 * Whether this tick re-posts the card, and whether the wrist buzzes for it.
 *
 * The initial post, worsening pacing edges, and a live buffer that lost a
 * meaningful step alert; everything else updates the existing entry silently.
 * An IMPROVING buffer is always silent — more flex than expected is not
 * something to buzz a rider about, it is something they read on the next
 * glance.
 */
function decideCadence(
  prev: PacingCardState | null,
  now: {
    bufferMin: number
    legKey: string
    live: boolean
    nowMs: number
    state: PacingState
  }
): { passive: boolean; post: boolean } {
  if (!prev || prev.legKey !== now.legKey) {
    return { passive: false, post: true }
  }
  const worsened = SEVERITY[now.state] > SEVERITY[prev.state]
  // A live buffer that has LOST two minutes or more is the rider's ask, and it
  // is worth a buzz even inside a single pacing band — losing four minutes of
  // flex while still nominally "comfortable" is exactly the news they were not
  // getting. Compared live-to-live only, so the feed dropping out mid-leg is
  // not mistaken for the trip going wrong; and it does not shortcut the 90 s
  // floor, because flex that erodes gently is not an emergency and one that
  // collapses crosses a band and takes the `worsened` path instead.
  const liveBufferLost =
    now.live &&
    prev.live &&
    prev.bufferMin - now.bufferMin >= REPOST_BUFFER_DELTA_MIN

  if (worsened) return { passive: false, post: true }

  const intervalOk = now.nowMs - prev.postedAtMs >= MIN_REPOST_INTERVAL_MS
  const changedEnough =
    now.state !== prev.state ||
    Math.abs(now.bufferMin - prev.bufferMin) >= REPOST_BUFFER_DELTA_MIN
  if (!intervalOk || !changedEnough) return { passive: true, post: false }
  return { passive: !liveBufferLost, post: true }
}

/**
 * The measured pair — how long the ride still takes at the pace the rider is
 * keeping, and how much of the bus's own predicted departure that leaves over
 * — or null when any of the three pieces of evidence is missing.
 *
 * A rider's own departure pick outranks the feed: liveLegTimes tracks the
 * PLANNED leg's trip, so once they have chosen a different bus that epoch
 * describes a vehicle they are not taking. Same rule getUpcomingTransitTiming
 * applies to effectiveDepartureMs.
 */
function measuredFlex(input: {
  currentLeg: Leg
  liveBoardEpochMs?: number | null
  nowMs: number
  observedSpeedMps?: number | null
  progress: TripProgress
}): { bufferSec: number; travelSec: number } | null {
  const { currentLeg, liveBoardEpochMs, nowMs, observedSpeedMps, progress } =
    input
  if (progress.departureIsOverridden) return null
  if (liveBoardEpochMs == null || !Number.isFinite(liveBoardEpochMs))
    return null
  if (
    observedSpeedMps == null ||
    !Number.isFinite(observedSpeedMps) ||
    observedSpeedMps <= 0
  ) {
    return null
  }
  const legAhead = legMetresAhead(currentLeg, progress.currentLegProgress)
  if (legAhead == null) return null
  const travelSec = legAhead / observedSpeedMps
  return {
    bufferSec: (liveBoardEpochMs - nowMs) / 1000 - travelSec,
    travelSec
  }
}

/**
 * Ground still ahead on the leg the rider is on, in metres. Plan distance —
 * the only distance an itinerary carries — scaled by how far along the
 * matcher puts them. Null when the leg carries no usable distance.
 */
function legMetresAhead(
  leg: Leg,
  currentLegProgressPct: number | undefined
): number | null {
  const distance = leg.distance
  if (distance == null || !Number.isFinite(distance) || distance <= 0) {
    return null
  }
  const pct = Number.isFinite(currentLegProgressPct as number)
    ? (currentLegProgressPct as number)
    : 0
  const done = Math.max(0, Math.min(1, pct / 100))
  return distance * (1 - done)
}
