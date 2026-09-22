import {
  LEAVE_SOON_THRESHOLD_SECONDS,
  minutesUntilBoarding
} from './notification-service'
import { notifyIntl } from './notify-i18n'
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
 * and what slack is left. (The "how hard to push" half of that ask shipped as
 * pacing words and was retired 2026-09-08: it is coaching, and the rider's
 * standing rule forbids it — the haptic carries the urgency instead.)
 *
 * The baseline is captured once per boarding and held. Quoting total drift is
 * the point — "6 min later" is actionable in a way that three separate "2 min
 * later" alerts are not — so re-alerts fire on each further ±2 min of movement
 * from the last figure the rider was told, in either direction. A bus that
 * hands back the time it borrowed is news too, and lands as "back on time".
 *
 * ## The rider's cadence (2026-09-21, backlog 24.4)
 *
 * The ±2 min step alone still let a steadily-late bus push four times in under
 * seven minutes on the 16:05 ride. So a second gate sits on top of it, in the
 * rider's own words: at most one departure-change push per bus per 5 minutes,
 * unless the change since they were last told is 5 min or more, or it drops
 * their slack to the leave-now line. The window is shared with the other
 * pushes that quote this boarding's minutes, which is what stops a drift alert
 * and a "Bus coming" contradicting each other over a departure that moved
 * between them. See DEPARTURE_DRIFT_MIN_GAP_MS.
 *
 * Pure: every clock arrives via nowMs, so the cadence is unit-testable.
 */

/** Movement from the last-announced figure worth another alert. */
export const DEPARTURE_DRIFT_ALERT_MS = 120000

/**
 * The rider's cadence, answered on the board 2026-09-21 22:42 (backlog 24.4):
 * "at most one departure-change push per bus every 5 minutes unless the change
 * is 5+ minutes or risks a miss, and the 'Bus coming' push must agree with it".
 *
 * MEASURED on `0921-1605-465-wrongdir.json` (session `mubq7tfx-8dz3ar`). The
 * baseline was 16:17:00, first seen at 16:07:39, and the feed then walked the
 * 465's departure one poll at a time — 16:18:42, 16:19:52, 16:21:02, 16:22:05,
 * 16:23:24, 16:24:25, 16:25:35, 16:26:45. Against the ±2 min step alone that
 * is four pushes in under seven minutes (16:14:31 "3 min later", 16:16:14
 * "5 min later", 16:19:18 "7 min later", 16:21:20 "10 min later" — the last of
 * them in the same second as "Bus here"), for a bus that was simply late and
 * about which the rider could do nothing new each time.
 *
 * The window is shared with the other pushes that quote this boarding's
 * minutes (lastBoardMinutesPushAtMs), which is the "must agree" half. Sharing
 * the epoch and the rounding was not enough: at 16:18:05 and 16:19:18 both
 * pushes read the SAME `liveLegTimes[1].boardEpoch` and still said "4 min" and
 * "5 min" 73 s apart, because the epoch itself had moved 2m20s. Two true
 * numbers that contradict each other are what the rider objected to, and only
 * one voice per window prevents them.
 */
export const DEPARTURE_DRIFT_MIN_GAP_MS = 300000

/**
 * A change big enough to speak inside the quiet window. The rider's "5+
 * minutes", measured from the figure they were last GIVEN — not from the
 * baseline, and not per poll: a bus that slips 2 min three times has moved six
 * minutes on the rider, and that is worth interrupting for.
 */
export const DEPARTURE_DRIFT_URGENT_MS = 300000

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
  /**
   * When the rider was last told this boarding's departure — by this module's
   * own alert or by the approach push folded in through `toldDepartureMs` —
   * or null before anything has. The rider's 5-minute cadence clock.
   */
  lastAlertAtMs: number | null
  /**
   * Signed drift of the figure the rider was last told; 0 = still at the
   * baseline. Set by a drift alert and by a folded-in approach push, so "the
   * change since they were last told" means the same thing either way.
   */
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
  /**
   * When another push last quoted this boarding's minutes to the rider —
   * `lastBoardMinutesPushAtMs(sentNotifications)`. Shares the quiet window so
   * a drift alert cannot contradict a "Bus coming" the rider just read.
   */
  lastBoardMinutesPushAtMs?: number | null
  /** Live (realtime-flagged) prediction for that boarding, epoch ms. */
  liveDepartureMs: number | null
  nowMs: number
  routeName: string
  /**
   * The departure epoch another push has quoted to the rider ON THIS TICK —
   * the approach alert's "Bus coming · N min", which reads the same
   * `boardPushEpochMs` this module does.
   *
   * It is folded into the baseline as a figure the rider now HOLDS, and this
   * tick says nothing itself. That is what makes the rider's "the 'Bus coming'
   * push must agree with it" true rather than hoped for: the next drift alert
   * is measured from the number they last read, whoever showed it to them, so
   * a departure that has moved 2 min since "Bus coming · 4 min" is no longer
   * news worth a second, contradicting push.
   */
  toldDepartureMs?: number | null
  /** progress.waitTimeAtStop — slack once the rider reaches the stop. */
  waitSeconds: number | null | undefined
}

/**
 * "8 min slack" / "2 min short" / '' when unknown.
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
  const intl = notifyIntl()
  return mins < 0
    ? intl.formatMessage(
        {
          defaultMessage: '{minutes} min short',
          id: 'components.GoMode.notify.slackShort'
        },
        { minutes: -mins }
      )
    : intl.formatMessage(
        {
          defaultMessage: '{minutes} min slack',
          id: 'components.GoMode.notify.slackLeft'
        },
        { minutes: mins }
      )
}

/**
 * Copy is the rider's standing notification rule (auto-memory
 * `minimal-notification-text`): the numbers they act on and nothing else.
 *
 * Two things it deliberately no longer does. It quoted the new departure as a
 * CLOCK TIME in the title — the rule's own words are that the wait in minutes
 * is what a rider on the pavement uses — and it appended `paceAdvice`
 * ("hurry" / "pick up the pace" / "take your time"), which is verbatim the
 * coaching the rider killed on 2026-07-22 ("Woah way way way too much info").
 * The haptic already carries the urgency: `losingSlack` below is what decides
 * whether the wrist buzzes, and it is unchanged.
 */
function composeAlert(
  input: DepartureDriftInput,
  driftMs: number,
  departureMs: number
): NotificationEvent {
  const { boardingKey, nowMs, routeName, waitSeconds } = input
  const intl = notifyIntl()
  const driftMin = Math.round(driftMs / 60000)
  // "later" / "earlier" are not a word slotted into one sentence: a language
  // that inflects either way needs the whole phrase, so each is its own
  // message (backlog 12.23).
  const change =
    driftMin === 0
      ? intl.formatMessage({
          defaultMessage: 'back on time',
          id: 'components.GoMode.notify.backOnTime'
        })
      : driftMin > 0
      ? intl.formatMessage(
          {
            defaultMessage: '{minutes} min later',
            id: 'components.GoMode.notify.driftLater'
          },
          { minutes: Math.abs(driftMin) }
        )
      : intl.formatMessage(
          {
            defaultMessage: '{minutes} min earlier',
            id: 'components.GoMode.notify.driftEarlier'
          },
          { minutes: Math.abs(driftMin) }
        )

  const slack = slackPhrase(waitSeconds)
  // Minutes until the departure, never its clock time — and through the same
  // helper the approach push uses, so the two can never round one epoch two
  // ways (24.4). It also retires this line's own `Math.max(0, …)`, which could
  // print "465 · 0 min" for a departure inside the stale grace.
  const awayMin = minutesUntilBoarding(departureMs, nowMs)

  // Losing slack is the case worth a buzz on the wrist; a bus handing time back
  // is good news and arrives without one (showNotification vibrates on 'high'
  // only). Both still reach the phone — the type is in PUSH_NOTIFICATION_TYPES.
  const losingSlack = driftMs < 0 || (waitSeconds != null && waitSeconds < 180)

  return {
    id: `DEPARTURE_CHANGED_${boardingKey}_${nowMs}`,
    // The toast renders the message alone, so it repeats the drift rather
    // than leaning on the title for it.
    message: slack
      ? intl.formatMessage(
          {
            defaultMessage: '{change} · {slack}',
            id: 'components.GoMode.notify.changeWithSlack'
          },
          { change, slack }
        )
      : change,
    priority: losingSlack ? 'high' : 'medium',
    timestamp: new Date(nowMs),
    title: intl.formatMessage(
      {
        defaultMessage: '{routeName} · {minutes} min',
        id: 'components.GoMode.notify.routeMinutes'
      },
      { minutes: awayMin, routeName }
    ),
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
  const { boardingKey, liveDepartureMs, nowMs, toldDepartureMs } = input
  if (!boardingKey) return { alert: null, next: null }

  // The baseline only counts if it belongs to THIS boarding.
  const baseline = prev?.boardingKey === boardingKey ? prev : null

  // Another push has just told the rider this boarding's departure. Record it
  // as the figure they now hold and stay quiet — two pushes about one bus in
  // one tick is the churn itself, and it is how 16:21:20 landed a "10 min
  // later" in the same second as "Bus here". Ahead of the staleness gate on
  // purpose: the approach alert deliberately still speaks for a prediction
  // just gone by ("late but coming"), and the window must start even then.
  if (baseline && toldDepartureMs != null && Number.isFinite(toldDepartureMs)) {
    return {
      alert: null,
      next: {
        ...baseline,
        lastAlertAtMs: nowMs,
        lastAlertedDriftMs: toldDepartureMs - baseline.baselineMs
      }
    }
  }

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
      next: {
        baselineMs: liveDepartureMs,
        boardingKey,
        lastAlertAtMs: null,
        lastAlertedDriftMs: 0
      }
    }
  }

  const driftMs = liveDepartureMs - baseline.baselineMs
  // Measured from the figure the rider was last given, not from the baseline:
  // that is what makes a slow slip re-alert at 2, 4, 6 min instead of once, and
  // what lets a recovering bus report its way back.
  const changeSinceLastAlertMs = driftMs - baseline.lastAlertedDriftMs
  if (Math.abs(changeSinceLastAlertMs) < DEPARTURE_DRIFT_ALERT_MS) {
    return { alert: null, next: baseline }
  }

  // The rider's cadence (24.4). Held, never discarded: `lastAlertedDriftMs` is
  // untouched while the window is shut, so when it opens the rider is told the
  // TOTAL movement — a bus that slipped 2 min three times in quiet reports
  // "6 min later", not the last increment.
  if (heldByCadence(input, baseline, changeSinceLastAlertMs)) {
    return { alert: null, next: baseline }
  }

  return {
    alert: composeAlert(input, driftMs, liveDepartureMs),
    next: {
      ...baseline,
      lastAlertAtMs: nowMs,
      lastAlertedDriftMs: driftMs
    }
  }
}

/**
 * Whether the rider's 5-minute cadence holds this alert back.
 *
 * Two things override the window, both of them the rider's own words:
 *
 *  - a change of 5 min or more since the figure they were last given. A bus
 *    that has moved that far has changed what they do, not just what they know.
 *  - a change that risks the miss. Slack is `progress.waitTimeAtStop` and the
 *    line is LEAVE_SOON's own threshold — the app's single definition of "you
 *    must go now to make this" — so the interrupt fires exactly when the alert
 *    the rider already understands would. A LATER bus cannot trip it: a
 *    departure that moves back hands slack over, it does not take it, which is
 *    why the direction is part of the test and not an afterthought.
 */
function heldByCadence(
  input: DepartureDriftInput,
  baseline: DepartureBaselineState,
  changeSinceLastAlertMs: number
): boolean {
  const { lastBoardMinutesPushAtMs, nowMs, waitSeconds } = input
  // The window starts at whichever push last quoted this boarding's minutes —
  // the drift alert's own, or "Bus coming" / "Leave in N min".
  const lastSpokeAtMs = Math.max(
    baseline.lastAlertAtMs ?? -Infinity,
    lastBoardMinutesPushAtMs ?? -Infinity
  )
  if (!Number.isFinite(lastSpokeAtMs)) return false
  if (nowMs - lastSpokeAtMs >= DEPARTURE_DRIFT_MIN_GAP_MS) return false

  const bigChange =
    Math.abs(changeSinceLastAlertMs) >= DEPARTURE_DRIFT_URGENT_MS
  const risksTheMiss =
    changeSinceLastAlertMs < 0 &&
    waitSeconds != null &&
    Number.isFinite(waitSeconds) &&
    waitSeconds <= LEAVE_SOON_THRESHOLD_SECONDS
  return !bigChange && !risksTheMiss
}
