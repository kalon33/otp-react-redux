/* eslint-disable @typescript-eslint/no-explicit-any */
import '../test-utils/mock-window-url'

import { handleBackButtonPress } from '../../lib/actions/ui'
import { resolveUrlItineraryIndex } from '../../lib/components/narrative/narrative-itineraries'
import { setActiveItinerary } from '../../lib/actions/narrative'
import coreUtils from '@opentripplanner/core-utils'

/**
 * Backlog 37.1 — 2026-09-30, session muomy26h-g1zujp, dev 2026.0930.1.
 *
 * 17:08:33  the return from /feedback re-ran the 16:46 search (23.4) and the
 *           re-planned list held the rider's trip 1:1273254 at position 44 as
 *           @29846751 — the URL still named it 42 / @29846746.
 * 17:09:29 – 17:11:38  on the results list, 94 SET_ACTIVE_ITINERARY:
 *           {index: 44}                                   x48 (the list's key restore)
 *           {index: "42", key: "1:1273254@29846746"}     x46 (the popstate handler)
 *           strictly alternating, until the app died at 17:11:39.
 *
 * The popstate handler compared the store's 44 with the URL's raw position
 * "42" — a real disagreement, not a type slip (isDefinedAndNotEqual compares
 * as strings) — and restored the position, while the list restored the key.
 */

const SEARCH = '8y6dpf1gh'
const KEY_IN_URL = '1:1273254@29846746' // the entry written before the re-plan
const KEY_NOW = '1:1273254@29846751' // the same trip in the re-planned list

/** A 46-row re-planned list: position 44 is the rider's trip, 5 min later. */
function replannedList(): any[] {
  return Array.from({ length: 46 }, (_, i) => {
    const trip = i === 44 ? '1:1273254' : `1:${1273000 + i}`
    const minute = i === 44 ? 29846751 : 29846700 + i
    return {
      duration: 1800 + i,
      endTime: (minute + 30) * 60000,
      legs: [
        {
          distance: 1000 + i,
          endTime: (minute + 30) * 60000,
          from: { lat: 44.91, lon: -93.23, name: `Stop ${i}` },
          mode: 'BUS',
          route: { shortName: `${i}` },
          routeId: `1:${i}`,
          startTime: minute * 60000,
          to: { lat: 44.81, lon: -93.3, name: 'Old Shakopee' },
          transitLeg: true,
          trip: { gtfsId: trip }
        }
      ],
      startTime: minute * 60000,
      transfers: 0,
      transitTime: 1800,
      waitingTime: 0,
      walkTime: 0
    }
  })
}

const urlFor = (index: number | string, key?: string) =>
  `/?ui_activeSearch=${SEARCH}&ui_activeItinerary=${index}` +
  (key ? `&ui_activeItineraryKey=${encodeURIComponent(key)}` : '')

/**
 * A minimal app: the SET_ACTIVE_ITINERARY reducer, connected-react-router's
 * history calls applied to the jsdom history, every PUSH answered with a
 * queued `popstate` (what WebKit does when the hash history assigns
 * location.hash), and the results list's componentDidUpdate restore run
 * synchronously inside the dispatch that re-renders it.
 */
function makeApp(activeItinerary: number | string) {
  const itineraries = replannedList()
  const state: any = {
    otp: {
      activeSearchId: SEARCH,
      config: {},
      searches: {
        [SEARCH]: {
          activeItinerary,
          pending: 0,
          query: {},
          response: [{ plan: { itineraries } }]
        }
      }
    },
    router: { location: { pathname: '/' } }
  }
  const log: any[] = []
  let queuedPopstates = 0
  const getState = () => state

  // narrative-itineraries.js componentDidUpdate, verbatim in what it decides
  function listRestore() {
    const { ui_activeItinerary: urlIndex, ui_activeItineraryKey: key } =
      coreUtils.query.getUrlParams() || ({} as any)
    if (urlIndex === undefined || urlIndex === '-1') return
    const restored = resolveUrlItineraryIndex({
      itineraries,
      key,
      pending: false,
      urlIndex: +urlIndex
    })
    const active = state.otp.searches[SEARCH].activeItinerary
    if (restored !== null && restored !== active) {
      // the component passes `true` (a restore); main's ignores it
      const restore: any = setActiveItinerary
      restore({ index: restored }, true)(dispatch, getState)
    }
  }

  function dispatch(action: any): any {
    if (typeof action === 'function') return action(dispatch, getState)
    log.push(action)
    if (action.type === 'SET_ACTIVE_ITINERARY') {
      state.otp.searches[SEARCH].activeItinerary = action.payload.index
      listRestore() // the re-render, inside the dispatch
    }
    if (action.type === '@@router/CALL_HISTORY_METHOD') {
      const { args, method } = action.payload
      if (method === 'push') {
        window.history.pushState({}, '', args[0])
        queuedPopstates++
      } else {
        window.history.replaceState({}, '', args[0])
      }
    }
    return action
  }

  /** Deliver queued popstates (cap: the 09-30 loop never ended by itself). */
  function drain(cap = 40) {
    let n = 0
    while (queuedPopstates > 0 && n < cap) {
      queuedPopstates--
      n++
      handleBackButtonPress({})(dispatch, getState)
    }
    return n
  }
  function popstate() {
    handleBackButtonPress({})(dispatch, getState)
  }
  const sets = () => log.filter((a) => a.type === 'SET_ACTIVE_ITINERARY')
  const historyCalls = () =>
    log
      .filter((a) => a.type === '@@router/CALL_HISTORY_METHOD')
      .map((a) => a.payload.method)
  return {
    dispatch,
    drain,
    getState,
    historyCalls,
    listRestore,
    log,
    popstate,
    sets
  }
}

describe('backlog 37.1 > the popstate restorer resolves by key', () => {
  it('the URL entry and the list name the same trip by key, at different positions', () => {
    const list = replannedList()
    expect(
      resolveUrlItineraryIndex({
        itineraries: list,
        key: KEY_IN_URL,
        pending: false,
        urlIndex: 42
      })
    ).toBe(44)
  })

  it('does nothing when the URL says "42" but its key resolves to the active 44', () => {
    window.history.replaceState({}, '', urlFor(42, KEY_IN_URL))
    const app = makeApp(44)
    app.popstate()
    expect(app.sets()).toEqual([])
    // ...and says so in the stream, with the entry it landed on
    const rec = app.log.find((a) => a.type === 'POPSTATE_ITINERARY_RESTORE')
    expect(rec?.payload).toMatchObject({
      active: 44,
      resolved: 44,
      urlIndex: '42',
      urlKey: KEY_IN_URL
    })
  })

  it('restores the keyed trip at its NEW position, replacing the entry', () => {
    window.history.replaceState({}, '', urlFor(42, KEY_IN_URL))
    const app = makeApp(10)
    app.popstate()
    expect(app.sets().map((a) => a.payload.index)).toEqual([44])
    expect(app.historyCalls()).toEqual(['replace'])
  })

  it('still honours a back press to a keyless entry by position', () => {
    window.history.replaceState({}, '', urlFor(5))
    const app = makeApp(3)
    app.popstate()
    expect(app.sets().map((a) => a.payload.index)).toEqual([5])
  })

  it('still clears the selection when the entry has none', () => {
    window.history.replaceState({}, '', `/?ui_activeSearch=${SEARCH}`)
    const app = makeApp(3)
    app.popstate()
    expect(app.sets().map((a) => a.payload.index)).toEqual([-1])
  })

  it('does not dispatch when the entry already matches (number vs string)', () => {
    window.history.replaceState({}, '', urlFor(44, KEY_NOW))
    const app = makeApp(44)
    app.popstate()
    expect(app.sets()).toEqual([])
  })
})

describe('backlog 37.1 > the 44 <-> "42" loop', () => {
  it('the list mount restores once, by replace, and raises no popstate', () => {
    // After the 17:08:33 re-plan: store at the URL's position 42, URL 42/@746.
    window.history.replaceState({}, '', urlFor(42, KEY_IN_URL))
    const app = makeApp(42)
    app.listRestore() // the 17:09:29 mount
    const popstates = app.drain()
    expect(app.sets().map((a) => a.payload.index)).toEqual([44])
    expect(app.historyCalls()).toEqual(['replace'])
    expect(popstates).toBe(0)
    expect(coreUtils.query.getUrlParams().ui_activeItinerary).toBe('44')
  })

  it('a popstate onto the stale 42 entry, twice, settles with at most one SET_ACTIVE_ITINERARY', () => {
    window.history.replaceState({}, '', urlFor(42, KEY_IN_URL))
    const app = makeApp(42)
    app.listRestore()
    // the observed popstate: the URL reads the pre-re-plan entry again
    window.history.replaceState({}, '', urlFor(42, KEY_IN_URL))
    app.popstate()
    app.drain()
    app.popstate()
    app.drain()
    // one from the mount restore; the two popstates add none
    expect(app.sets().length).toBeLessThanOrEqual(1)
  })
})
