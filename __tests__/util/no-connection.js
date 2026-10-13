/* globals describe, expect, it */

import '../test-utils/mock-window-url'
import {
  getActiveError,
  getErrorMessage,
  isNoConnectionSearch
} from '../../lib/util/state'

const intl = { formatMessage: ({ id }) => id }
const timedOut = () =>
  Object.assign(new Error('Request timed out after 20000 ms'), {
    timedOut: true
  })
const failed = () => new TypeError('Load failed')
const server500 = () =>
  Object.assign(new Error('Received error from server'), {
    response: { status: 500 }
  })
const err = (error) => ({ error, url: 'x?mode=TRANSIT' })
const stateOf = (response, pending = 0) => ({
  otp: {
    activeSearchId: 's',
    searches: { s: { pending, response } }
  }
})
const idOf = (state) => getErrorMessage(getActiveError(state), intl).props.id

describe('20.1 no-connection planner card', () => {
  it('all sub-queries timed out -> No connection', () => {
    const state = stateOf([err(timedOut()), err(timedOut()), err(timedOut())])
    expect(isNoConnectionSearch(state.otp.searches.s)).toBe(true)
    expect(idOf(state)).toBe('util.state.noConnection')
  })
  it('all sub-queries network-failed -> No connection', () => {
    const state = stateOf([err(failed()), err(failed()), err(failed())])
    expect(idOf(state)).toBe('util.state.noConnection')
  })
  it('timeouts mixed with network failures -> No connection', () => {
    expect(idOf(stateOf([err(timedOut()), err(failed())]))).toBe(
      'util.state.noConnection'
    )
  })
  it('one real server error -> today text', () => {
    const state = stateOf([err(timedOut()), err(server500()), err(timedOut())])
    expect(idOf(state)).toBe('util.state.errorPlanningTrip')
  })
  it('partial failure (one answered) -> today text', () => {
    const state = stateOf([
      { plan: { itineraries: [] } },
      err(timedOut()),
      err(timedOut())
    ])
    expect(isNoConnectionSearch(state.otp.searches.s)).toBe(false)
    expect(idOf(state)).toBe('util.state.errorPlanningTrip')
  })
  it('requests still outstanding -> not yet', () => {
    const state = stateOf([err(timedOut()), err(timedOut())], 1)
    expect(idOf(state)).toBe('util.state.errorPlanningTrip')
  })
})
