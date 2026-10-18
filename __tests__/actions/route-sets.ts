import { applyMiddleware, combineReducers, createStore } from 'redux'
import thunk from 'redux-thunk'

import {
  applySavedRouteSet,
  deleteRouteSet,
  renameRouteSet,
  saveRouteSet
} from '../../lib/actions/route-sets'
import { FETCH_STATUS } from '../../lib/util/constants'
// The jest stand-in for util/debug-log keeps what was recorded.
import { recordedSessionEvents } from '../test-utils/mock-data/debug-log'
import createUserReducer from '../../lib/reducers/create-user-reducer'

// Count searches instead of running them: setQueryParam(patch, searchId)
// dispatches routingQuery(searchId), and that is "one search".
jest.mock('../../lib/actions/api', () => ({
  ...jest.requireActual('../../lib/actions/api'),
  routingQuery: (searchId: string) => ({
    payload: searchId,
    type: 'TEST_ROUTING_QUERY'
  })
}))

const ROUTES = {
  '1:18': { longName: null, shortName: '18', sortOrder: 18 },
  '1:21': { longName: null, shortName: '21', sortOrder: 21 },
  '1:904': { longName: 'METRO Orange Line', shortName: null, sortOrder: 4 },
  '1:921': { longName: 'METRO A Line', shortName: null, sortOrder: 21 }
}

const config = { persistence: { enabled: true, strategy: 'localStorage' } }

/**
 * A launch: the real user reducer (built from whatever localStorage holds)
 * beside a fixed otp slice with a VALID query, so a write that re-searches
 * really would. Every plain action is kept.
 */
function launch(currentQuery: any = {}) {
  const actions: any[] = []
  const otp = {
    config: {},
    currentQuery: {
      from: { lat: 44.8168, lon: -93.3102, name: 'Home' },
      to: { lat: 45.0, lon: -92.9489, name: 'Oakdale' },
      ...currentQuery
    },
    transitIndex: { routes: ROUTES, routesFetchStatus: FETCH_STATUS.FETCHED }
  }
  const log = () => (next: any) => (action: any) => {
    if (typeof action !== 'function') actions.push(action)
    return next(action)
  }
  const store = createStore(
    combineReducers({ otp: () => otp, user: createUserReducer(config) }),
    applyMiddleware(thunk, log)
  )
  const searches = () =>
    actions.filter((a) => a.type === 'TEST_ROUTING_QUERY').length
  const locks = () =>
    actions
      .filter((a) => a.type === 'SET_QUERY_PARAM' && 'routeLock' in a.payload)
      .map((a) => a.payload.routeLock)
  const sets = () => store.getState().user.localUser.routeSets
  return { actions, locks, searches, sets, store }
}

describe('lib > actions > route-sets (58.2 saved sets)', () => {
  beforeEach(() => {
    recordedSessionEvents.length = 0
    window.localStorage.clear()
  })

  describe('saveRouteSet', () => {
    it('saves the ticked routes with the labels the sheet showed, searches nothing', () => {
      const { searches, sets, store } = launch()
      const result: any = store.dispatch(
        saveRouteSet('Commute', ['1:18', '1:21', '1:904'], 'only') as any
      )
      expect(result.ok).toBe(true)
      expect(sets()).toHaveLength(1)
      expect(sets()[0]).toMatchObject({
        name: 'Commute',
        routes: [
          { id: '1:18', label: '18' },
          { id: '1:21', label: '21' },
          { id: '1:904', label: 'METRO Orange Line' }
        ],
        scope: 'only'
      })
      expect(searches()).toBe(0)
      expect(recordedSessionEvents).toEqual([
        {
          count: 3,
          event: 'ROUTE_SET_SAVED',
          replaced: false,
          scope: 'only',
          sets: 1
        }
      ])
    })

    it('a taken name is refused (the sheet then asks "Replace Commute?")', () => {
      const { sets, store } = launch()
      store.dispatch(saveRouteSet('Commute', ['1:18'], 'only') as any)
      const id = sets()[0].id
      const refused: any = store.dispatch(
        saveRouteSet('commute', ['1:21'], 'starting') as any
      )
      expect(refused).toMatchObject({ error: 'exists', ok: false })
      expect(refused.existing.name).toBe('Commute')
      expect(sets()[0].routes.map((r: any) => r.id)).toEqual(['1:18'])

      const replaced: any = store.dispatch(
        saveRouteSet('commute', ['1:21'], 'starting', { replace: true }) as any
      )
      expect(replaced.ok && replaced.replaced).toBe(true)
      expect(sets()).toHaveLength(1)
      expect(sets()[0]).toMatchObject({ id, scope: 'starting' })
      expect(recordedSessionEvents.map((e: any) => e.replaced)).toEqual([
        false,
        true
      ])
    })

    it('a route the index lacks keeps the label the lock on the query gave it', () => {
      const { sets, store } = launch({
        routeLock: { routes: [{ id: '9:77', label: '77' }], scope: 'only' }
      })
      store.dispatch(saveRouteSet('Odd', ['9:77'], 'only') as any)
      expect(sets()[0].routes).toEqual([{ id: '9:77', label: '77' }])
    })
  })

  describe('rename and delete', () => {
    it('rename refuses a name another set has; delete removes; both persist', () => {
      let app = launch()
      app.store.dispatch(saveRouteSet('Commute', ['1:18'], 'only') as any)
      app.store.dispatch(saveRouteSet('Gym', ['1:21'], 'only') as any)
      const [gym, commute] = app.sets()
      expect(
        (app.store.dispatch(renameRouteSet(gym.id, 'COMMUTE') as any) as any)
          .error
      ).toBe('exists')
      app.store.dispatch(renameRouteSet(gym.id, 'Lifting') as any)
      app.store.dispatch(deleteRouteSet(commute.id) as any)
      // Reload.
      app = launch()
      expect(app.sets().map((s: any) => s.name)).toEqual(['Lifting'])
    })
  })

  describe('applySavedRouteSet', () => {
    function withCommute(currentQuery?: any) {
      const app = launch(currentQuery)
      app.store.dispatch(
        saveRouteSet('Commute', ['1:18', '1:21', '1:904'], 'starting') as any
      )
      recordedSessionEvents.length = 0
      return { ...app, set: app.sets()[0] }
    }

    it('from the sheet (default): the set and its scope, ONE search, source saved', async () => {
      const { locks, searches, set, store } = withCommute({
        routeLock: { routes: [{ id: '1:921', label: 'A' }], scope: 'only' }
      })
      const result: any = await store.dispatch(
        applySavedRouteSet(set.id) as any
      )
      expect(searches()).toBe(1)
      // Replaces what was there — not added to it.
      expect(locks()[0].routes.map((r: any) => r.id)).toEqual([
        '1:18',
        '1:21',
        '1:904'
      ])
      expect(locks()[0].scope).toBe('starting')
      expect(result.missing).toEqual([])
      expect(recordedSessionEvents).toEqual([
        {
          count: 3,
          event: 'ROUTE_SET_APPLIED',
          scope: 'starting',
          source: 'saved'
        }
      ])
    })

    it('in Settings (replan: false): written, but NO search until Settings closes', async () => {
      const { locks, searches, set, store } = withCommute()
      await store.dispatch(applySavedRouteSet(set.id, { replan: false }) as any)
      expect(locks()).toHaveLength(1)
      expect(searches()).toBe(0)
    })

    it('a route no longer in the graph is left out and named back', async () => {
      const { locks, searches, store } = launch()
      window.localStorage.clear()
      // A set saved against an older graph: the 99 is gone.
      store.dispatch({
        payload: {
          draft: {
            name: 'Commute',
            routes: [
              { id: '1:18', label: '18' },
              { id: '1:99', label: '99' }
            ],
            scope: 'only'
          },
          id: 'set-old',
          now: 1,
          replace: false
        },
        type: 'SAVE_ROUTE_SET'
      })
      const result: any = await store.dispatch(
        applySavedRouteSet('set-old') as any
      )
      expect(result.missing).toEqual([{ id: '1:99', label: '99' }])
      expect(locks()[0].routes.map((r: any) => r.id)).toEqual(['1:18'])
      expect(searches()).toBe(1)
      // The saved set itself is left whole.
      expect(store.getState().user.localUser.routeSets[0].routes).toHaveLength(
        2
      )
    })

    it('a set with no running route writes nothing and searches nothing', async () => {
      const { locks, searches, store } = launch()
      store.dispatch({
        payload: {
          draft: {
            name: 'Gone',
            routes: [{ id: '1:99', label: '99' }],
            scope: 'only'
          },
          id: 'set-gone',
          now: 1,
          replace: false
        },
        type: 'SAVE_ROUTE_SET'
      })
      const result: any = await store.dispatch(
        applySavedRouteSet('set-gone') as any
      )
      expect(result.lock).toBeNull()
      expect(locks()).toHaveLength(0)
      expect(searches()).toBe(0)
    })
  })
})
