/**
 * Ask a transit leg's board stop how often the leg's route runs (backlog
 * 58.1). What is asked and how the answer becomes a line:
 * util/leg-frequency.ts.
 *
 * One stop-times request per leg question, cached app-wide under the
 * question's key (board stop | route | alighting stop | window) so the
 * planner's opened trip, Go Mode's trip sheet and Go Mode's transfer card
 * share it and a re-render never asks again. A failed request is retried no
 * sooner than two minutes later. Requests go out one at a time — the server
 * these go to has timed out under load (20.1). Nothing is asked during a
 * trip replay: the line is not part of what a replay verifies, and the
 * fixture has no answer for it.
 */
import { createAction } from 'redux-actions'
import type { Leg } from '@opentripplanner/types'

import { isReplayActive } from '../util/go-mode/replay/replay-engine'
import {
  LEG_FREQUENCY_QUERY,
  LegFrequencyAnswer,
  LegFrequencyEntry,
  legFrequencyNeedsFetch,
  legFrequencyQuestion,
  legFrequencyRuns
} from '../util/leg-frequency'

import { createGraphQLQueryAction } from './apiV2'

/**
 * One cache entry. Times and trip ids only: this action goes out on the
 * debug stream, and the entry carries nothing about the rider but the
 * stop|route|stop key every route-row timetable status already logs.
 */
export const legFrequencyStatus = createAction<{
  entry: LegFrequencyEntry
  key: string
}>('LEG_FREQUENCY')

/** How long the request may take before the leg is left without a line. */
const LEG_FREQUENCY_TIMEOUT_MS = 12000

let queue: Promise<unknown> = Promise.resolve()

function fetchAnswer(
  dispatch: any,
  variables: Record<string, unknown>
): Promise<LegFrequencyAnswer | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), LEG_FREQUENCY_TIMEOUT_MS)
    const done = (value: LegFrequencyAnswer | null) => {
      clearTimeout(timer)
      resolve(value)
    }
    try {
      Promise.resolve(
        dispatch(
          createGraphQLQueryAction(
            LEG_FREQUENCY_QUERY,
            variables,
            (payload: any) => () =>
              done(payload?.errors ? null : payload?.data || null),
            () => () => done(null),
            { noThrottle: true, timeoutMs: LEG_FREQUENCY_TIMEOUT_MS }
          )
        )
      ).catch(() => done(null))
    } catch (e) {
      done(null)
    }
  })
}

/**
 * Fill the cache for one leg, unless it is already there, in flight, or the
 * leg has nothing to ask. Resolves once the answer (or failure) is stored.
 */
export function fetchLegFrequency(leg: Leg | null | undefined) {
  return function (dispatch: any, getState: any): Promise<void> {
    if (isReplayActive()) return Promise.resolve()
    const question = legFrequencyQuestion(leg)
    if (!question) return Promise.resolve()
    const { key } = question
    const cached = getState()?.otp?.legFrequency?.[key]
    if (!legFrequencyNeedsFetch(cached, Date.now())) return Promise.resolve()
    dispatch(
      legFrequencyStatus({
        entry: { fetchedAt: Date.now(), status: 'pending' },
        key
      })
    )
    const run = async () => {
      const answer = await fetchAnswer(dispatch, {
        startTime: question.startTime,
        stopId: question.stopId,
        timeRange: question.timeRange
      })
      if (!answer) {
        dispatch(
          legFrequencyStatus({
            entry: { fetchedAt: Date.now(), status: 'failed' },
            key
          })
        )
        return
      }
      const { runs, windowEndMs } = legFrequencyRuns(answer, question)
      dispatch(
        legFrequencyStatus({
          entry: { fetchedAt: Date.now(), runs, status: 'done', windowEndMs },
          key
        })
      )
    }
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }
}
