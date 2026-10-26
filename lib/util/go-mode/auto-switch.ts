import coreUtils from '@opentripplanner/core-utils'
import type { Itinerary } from '@opentripplanner/types'

import { AUTO_PRESETS } from './auto-priority'
import {
  FASTER_ROUTE_MIN_SAVING_MS,
  LESS_BIKE_MIN_METERS,
  routeSetOf
} from './faster-route'
import type {
  AutoAlightScore,
  AutoAlightVerdict,
  AutoPreset,
  AutoPresetVerdict,
  AutoScore
} from './auto-priority'

/**
 * Auto mode's switching rules (backlog 65.2, cycle 36 B2). Pure: B1's
 * `autoPresetVerdict` / `rankAlightForPreset` say which route a preset would
 * take; this says whether Auto may take it WITHOUT A TAP now, and what the
 * Undo card carries. The thunks in actions/go-mode.ts act on the answer.
 *
 * With Auto off nothing here is consulted, and the trip behaves exactly as
 * before: the faster-route card offers, the rider taps.
 */

/** No more than this many no-tap switches in one trip. */
export const AUTO_MAX_SWITCHES_PER_TRIP = 3

/**
 * Off the bus, a pick must be the same route set on this many consecutive
 * background answers before Auto switches. B1's sweep (82 fixtures, 348
 * off-bus answers, 2026-10-25): switching on the first answer, Fastest made
 * 12 switches with one flip back (0921-0902-orange-lake-st, Orange → 546+465
 * at 09:15:01 → Orange at 09:18:03); on the second agreeing answer, 5
 * switches and no reversal for any preset.
 */
export const AUTO_CONFIRM_ANSWERS = 2

/**
 * Aboard, the get-off check asks every 6 min and stops 4 min before the
 * planned stop, so a second agreeing answer usually never comes: on
 * ride-1020-0907 the 09:22:06 answer's Gold Line at 5th St & Cedar would have
 * been taken only at 09:25:08 (3 min later, onto a plan 10 min later than the
 * first answer's). One answer, as the tap card does today; the
 * never-back-to-a-left-route rule and the cap still hold.
 */
export const AUTO_ABOARD_CONFIRM_ANSWERS = 1

/** Undo stays on the card this long at most... */
export const AUTO_UNDO_MAX_MS = 300000
/** ...and aboard, until this long before the bus reaches the new stop. */
export const AUTO_UNDO_ABOARD_LEAD_MS = 60000

/**
 * The Auto switch's one push, on its own native id: 7, after the faster-route
 * offer's 6, so a card lapsing (which takes 6 back) leaves it alone.
 */
export const AUTO_SWITCH_NOTICE_ID = 7

/** Device storage key for the last-picked preset (not the trip's). */
export const AUTO_PRESET_STORAGE_KEY = 'autoPreset'

/** What the Undo card shows and what Undo puts back. */
export interface AutoUndo {
  aboard: boolean
  /** Biking the switch added, metres (0 when it saved). */
  addedBikeM: number
  bikeSavedM: number
  /** Vehicle changes the switch saved (bar minus pick, ≥ 0). */
  changesSaved: number
  expiresAtMs: number
  /** The plan the rider was on, exactly as it was. */
  fromItinerary: Itinerary
  fromRouteSet: string
  /** Which number leads the card: the preset's reason for the switch. */
  headline: 'faster' | 'fewerChanges' | 'lessBike'
  laterMs: number
  preset: AutoPreset
  routeLabel: string
  savingMs: number
  /** Aboard: the stop to get off at. */
  stopName?: string | null
  switchId: string
  toRouteSet: string
  /** Aboard: the bus the switch is about (Undo re-asserts riding on it). */
  tripId?: string | null
}

export interface AutoState {
  /** Route sets this trip has left or undone — never switched to again. */
  leftRouteSets: string[]
  on: boolean
  preset: AutoPreset
  /** No-tap switches made this trip. */
  switches: number
  undo: AutoUndo | null
}

export const AUTO_OFF: AutoState = {
  leftRouteSets: [],
  on: false,
  preset: 'fastest',
  switches: 0,
  undo: null
}

/** The agreeing-answers count behind a pick still being confirmed. */
export interface AutoPending {
  count: number
  key: string
}

export type AutoHoldWhy =
  | 'cap'
  | 'confirming'
  | 'no-pick'
  | 'off'
  | 'stay-on-route'
  | 'switch-back'
  | 'weak-bar'

export interface AutoDecision<T> {
  /** Carry this into the next answer's decision. */
  pending: AutoPending | null
  /** The pick acted on now, or (held) the one Auto would have taken. */
  pick: T | null
  why: AutoHoldWhy | 'switch'
}

export const isAutoPreset = (p: unknown): p is AutoPreset =>
  typeof p === 'string' && (AUTO_PRESETS as string[]).includes(p)

/**
 * May Auto switch, off the bus, to this answer's pick?
 *
 * - Stay on my route never takes a different route (the tap card stands);
 * - the bar must be the rider's own trips (or an earlier run of their own
 *   route): an `own-next-trip` bar is the rider's next bus with whatever onward
 *   OTP chose, and that weak bar drove ride-0930-1648's Least biking flap
 *   (904 → 18+924 → 904 → 18+924 inside 3 min, B1);
 * - never back to a route set this trip has left or undone (the next
 *   qualifier is taken instead);
 * - at most AUTO_MAX_SWITCHES_PER_TRIP;
 * - the same route set on AUTO_CONFIRM_ANSWERS consecutive answers.
 */
export function decideOffBusAutoSwitch(
  verdict: AutoPresetVerdict | null,
  auto: Pick<AutoState, 'leftRouteSets' | 'on' | 'preset' | 'switches'>,
  pending: AutoPending | null,
  confirmAnswers = AUTO_CONFIRM_ANSWERS
): AutoDecision<AutoScore> {
  if (!auto.on) return { pending: null, pick: null, why: 'off' }
  if (auto.preset === 'stayOnRoute') {
    return { pending: null, pick: null, why: 'stay-on-route' }
  }
  if (!verdict?.pool || !verdict.ranked.length) {
    return { pending: null, pick: null, why: 'no-pick' }
  }
  const open = verdict.ranked.find(
    (s) => !auto.leftRouteSets.includes(routeSetOf(s.itinerary))
  )
  if (verdict.pool.barSource === 'own-next-trip') {
    return { pending: null, pick: open ?? null, why: 'weak-bar' }
  }
  if (!open) {
    return { pending: null, pick: verdict.ranked[0], why: 'switch-back' }
  }
  if (auto.switches >= AUTO_MAX_SWITCHES_PER_TRIP) {
    return { pending: null, pick: open, why: 'cap' }
  }
  return confirm(open, routeSetOf(open.itinerary), pending, confirmAnswers)
}

function confirm<T>(
  pick: T,
  key: string,
  pending: AutoPending | null,
  needed: number
): AutoDecision<T> {
  const count = pending && pending.key === key ? pending.count + 1 : 1
  if (count < needed) {
    return { pending: { count, key }, pick, why: 'confirming' }
  }
  return { pending: null, pick, why: 'switch' }
}

/** The aboard pick's identity: the stop and the onward route set. */
export const aboardPickKey = (s: AutoAlightScore): string =>
  `${s.option.stopId}#${routeSetOf(s.option.itinerary)}`

/**
 * May Auto switch, aboard, to this get-off pick? Same rules as off the bus,
 * judged on the ONWARD route set (the bus the rider is on is not changing),
 * with AUTO_ABOARD_CONFIRM_ANSWERS agreeing answers. Stay on my route takes
 * only rankAlightForPreset's own same-route pick (the planned onward route
 * from another stop), as B1 ranks it.
 */
export function decideAboardAutoSwitch(
  verdict: AutoAlightVerdict | null,
  auto: Pick<AutoState, 'leftRouteSets' | 'on' | 'preset' | 'switches'>,
  pending: AutoPending | null,
  confirmAnswers = AUTO_ABOARD_CONFIRM_ANSWERS
): AutoDecision<AutoAlightScore> {
  if (!auto.on) return { pending: null, pick: null, why: 'off' }
  if (!verdict || !verdict.ranked.length) {
    return { pending: null, pick: null, why: 'no-pick' }
  }
  const open = verdict.ranked.find(
    (s) => !auto.leftRouteSets.includes(routeSetOf(s.option.itinerary))
  )
  if (!open) {
    return { pending: null, pick: verdict.ranked[0], why: 'switch-back' }
  }
  if (auto.switches >= AUTO_MAX_SWITCHES_PER_TRIP) {
    return { pending: null, pick: open, why: 'cap' }
  }
  return confirm(open, aboardPickKey(open), pending, confirmAnswers)
}

/**
 * Which number the card and push lead with — the preset's reason for the
 * switch: Least biking says the kilometres when it saved one, Simplest the
 * changes when it saved one, everything else (and Fastest's ≥ 3 min) the
 * minutes; Fastest's ±2 min less-biking pick says the kilometres.
 */
export function autoHeadline(
  preset: AutoPreset,
  s: { bikeSavedM: number; changesSaved: number; savingMs: number }
): AutoUndo['headline'] {
  if (preset === 'simplest' && s.changesSaved > 0) return 'fewerChanges'
  if (preset === 'leastBike' && s.bikeSavedM >= LESS_BIKE_MIN_METERS) {
    return 'lessBike'
  }
  if (s.savingMs >= FASTER_ROUTE_MIN_SAVING_MS) return 'faster'
  if (s.bikeSavedM >= LESS_BIKE_MIN_METERS) return 'lessBike'
  return s.changesSaved > 0 ? 'fewerChanges' : 'faster'
}

/**
 * Off the bus, Undo lasts until the bus the rider left would leave (its live
 * board time when the card has one), or AUTO_UNDO_MAX_MS, whichever is first.
 */
export function offBusUndoExpiresAt(
  nowMs: number,
  oldBoardMs: number | null | undefined
): number {
  const cap = nowMs + AUTO_UNDO_MAX_MS
  return oldBoardMs != null && Number.isFinite(oldBoardMs) && oldBoardMs > nowMs
    ? Math.min(cap, oldBoardMs)
    : cap
}

/**
 * Aboard, until AUTO_UNDO_ABOARD_LEAD_MS before the bus reaches the new stop —
 * or the old one, if that comes first (past it, staying on to it is gone).
 */
export function aboardUndoExpiresAt(
  newStopArrivalMs: number | null | undefined,
  oldStopArrivalMs: number | null | undefined
): number {
  const at = [newStopArrivalMs, oldStopArrivalMs]
    .filter((ms): ms is number => ms != null && Number.isFinite(ms))
    .map((ms) => ms - AUTO_UNDO_ABOARD_LEAD_MS)
  return at.length ? Math.min(...at) : 0
}

/** Is the Undo still on offer at `nowMs`? */
export const autoUndoLive = (
  undo: AutoUndo | null | undefined,
  nowMs: number
): undo is AutoUndo => !!undo && nowMs < undo.expiresAtMs

/** The last-picked preset on this device (Fastest on first use). */
export function loadAutoPreset(): AutoPreset {
  try {
    const p = coreUtils.storage.getItem(AUTO_PRESET_STORAGE_KEY, null)
    return isAutoPreset(p) ? p : 'fastest'
  } catch {
    return 'fastest'
  }
}

export function saveAutoPreset(preset: AutoPreset): void {
  try {
    coreUtils.storage.storeItem(AUTO_PRESET_STORAGE_KEY, preset)
  } catch {
    // best-effort: the trip still carries it
  }
}

/**
 * Auto as a saved session brings it back. A trip that is already over comes
 * back with Auto off (there is nothing left to switch). The Undo is not
 * saved: it names a moment, and a reload has moved past it.
 */
export function restoreAutoState(
  saved: Partial<AutoState> | null | undefined,
  arrivedAt: number | null | undefined
): AutoState {
  if (!saved || typeof saved !== 'object' || arrivedAt != null) return AUTO_OFF
  return {
    leftRouteSets: Array.isArray(saved.leftRouteSets)
      ? saved.leftRouteSets.filter((s) => typeof s === 'string')
      : [],
    on: saved.on === true,
    preset: isAutoPreset(saved.preset) ? saved.preset : 'fastest',
    switches:
      typeof saved.switches === 'number' && saved.switches >= 0
        ? saved.switches
        : 0,
    undo: null
  }
}
