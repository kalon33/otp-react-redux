/**
 * Fill each route row's "You leave" list from its boarding stop's timetable
 * (backlog 36.1). What qualifies and how a departure becomes an itinerary of
 * the row: util/route-row-timetable.ts.
 *
 * Once a search has settled, each qualifying row costs ONE stop-times request
 * (the stop's departures of the row's route across the search window, with
 * each bus's call at the rider's alighting stop in the same answer). The
 * request's status is stored on the search under the row's key, so a
 * re-render, a second batch of the same search, or the filled itineraries'
 * own arrival never ask again. What the timetable adds is appended at the END
 * of the search's responses (`ROUTING_RESPONSE_EXTRA`, as the "Other stops"
 * lookup does), so no itinerary already on screen changes position (23.5).
 */
import { createAction } from 'redux-actions'
import type { Itinerary } from '@opentripplanner/types'

import {
  clampSearchWindow,
  DEFAULT_SEARCH_WINDOW_SECONDS
} from '../util/routing-profiles'
import {
  FillableItinerary,
  fillRowFromTimetable,
  ROUTE_ROW_TIMETABLE_QUERY,
  searchWindowOf,
  TimetableAnswer,
  timetableRowQuestion
} from '../util/route-row-timetable'

import { createGraphQLQueryAction } from './apiV2'
import { routingResponseExtra } from './other-stops-lookup'

export type RouteRowTimetableStatus = 'pending' | 'done' | 'failed'

export interface RouteRowTimetableEntry {
  /** Departures added to the row. */
  found?: number
  status: RouteRowTimetableStatus
}

/**
 * Status of one row's timetable request, keyed by the row's
 * stop|route|alight|access key. Integers and a status only: this action goes
 * out on the debug stream, and although a stop id is public, the pair of them
 * is the rider's trip.
 */
export const routeRowTimetableStatus = createAction<
  RouteRowTimetableEntry & { key: string; searchId: string }
>('ROUTE_ROW_TIMETABLE')

/** How long the stop-times request may take before the row is left as is. */
const TIMETABLE_TIMEOUT_MS = 12000

/** A row as the result list renders it: representative plus folded runs. */
export type TimetableRow = FillableItinerary & {
  allStartTimes?: Array<{ itinerary: FillableItinerary }>
  sameShapeVariants?: FillableItinerary[]
}

/** The row's returned runs, representative first. */
function returnedRuns(row: TimetableRow): FillableItinerary[] {
  const runs: FillableItinerary[] = [row]
  const add = (run?: FillableItinerary) => {
    if (!run || run.timetableFill || runs.includes(run)) return
    if (runs.some((r) => r.index !== undefined && r.index === run.index)) {
      return
    }
    runs.push(run)
  }
  ;(row.sameShapeVariants || []).forEach(add)
  ;(row.allStartTimes || []).forEach((time) => add(time.itinerary))
  return runs
}

function fetchTimetable(
  dispatch: any,
  variables: Record<string, unknown>
): Promise<TimetableAnswer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), TIMETABLE_TIMEOUT_MS)
    const done = (value: TimetableAnswer | null) => {
      clearTimeout(timer)
      resolve(value)
    }
    try {
      Promise.resolve(
        dispatch(
          createGraphQLQueryAction(
            ROUTE_ROW_TIMETABLE_QUERY,
            variables,
            (payload: any) => () =>
              done(payload?.errors ? null : payload?.data || null),
            () => () => done(null),
            { noThrottle: true, timeoutMs: TIMETABLE_TIMEOUT_MS }
          )
        )
      ).catch(() => done(null))
    } catch (e) {
      done(null)
    }
  })
}

/**
 * Fill the qualifying rows of the active search, once per row per search.
 * `rows` are the merged rows the list renders. Nothing happens while the
 * search is still answering, during a Go Mode trip (its plans are
 * deliberately a narrow window and every request is bytes on a moving bus),
 * or for a search that is no longer the active one when the answer lands.
 */
export function fillRouteRowTimetables(rows: TimetableRow[]) {
  return async function (dispatch: any, getState: any): Promise<void> {
    const state = getState()
    const otp = state.otp
    const searchId: string | undefined = otp?.activeSearchId
    const search = searchId ? otp.searches?.[searchId] : null
    if (!searchId || !search || search.pending > 0) return
    if (otp.goMode?.isActive) return
    const homeTimezone: string | undefined = otp.config?.homeTimezone
    if (!homeTimezone) return
    const fallbackWindow = clampSearchWindow(
      otp.config?.itinerary?.searchWindowSeconds,
      DEFAULT_SEARCH_WINDOW_SECONDS
    )

    const stillActive = () => {
      const now = getState().otp
      return now?.activeSearchId === searchId && !!now?.searches?.[searchId]
    }
    const asked = new Set<string>(Object.keys(search.routeRowTimetable || {}))

    // Claim every row first, so a second call made while the first request
    // is out (the next render) finds them all taken and asks nothing.
    const todo: Array<{
      question: NonNullable<ReturnType<typeof timetableRowQuestion>>
      row: TimetableRow
      window: NonNullable<ReturnType<typeof searchWindowOf>>
    }> = []
    for (const row of rows || []) {
      const question = timetableRowQuestion(row)
      if (!question || asked.has(question.key)) continue
      const window = searchWindowOf(row, homeTimezone, fallbackWindow)
      if (!window) continue
      asked.add(question.key)
      todo.push({ question, row, window })
      dispatch(
        routeRowTimetableStatus({
          key: question.key,
          searchId,
          status: 'pending'
        })
      )
    }

    // One at a time: the server these go to has timed out under load (20.1).
    for (const { question, row, window } of todo) {
      const { key } = question
      // Every leave time inside the window boards within [start + access,
      // end + access]; the stop is asked for exactly that span.
      const answer = await fetchTimetable(dispatch, {
        serviceDate: window.serviceDate,
        startTime: Math.floor((window.startMs + question.accessMs) / 1000),
        stopId: question.stopId,
        timeRange: Math.ceil((window.endMs - window.startMs) / 1000) + 60
      })
      if (!stillActive()) return
      if (!answer) {
        dispatch(routeRowTimetableStatus({ key, searchId, status: 'failed' }))
        continue
      }
      const found = fillRowFromTimetable({
        answer,
        nowMs: Date.now(),
        rowRuns: returnedRuns(row),
        window
      })
      if (found.length) {
        dispatch(
          routingResponseExtra({
            response: {
              plan: { itineraries: found as Itinerary[] },
              requestId: `route-row-timetable-${key}`,
              routeRowTimetable: true
            },
            searchId
          })
        )
      }
      dispatch(
        routeRowTimetableStatus({
          found: found.length,
          key,
          searchId,
          status: 'done'
        })
      )
    }
  }
}
