import {
  applyRouteLocksFromText,
  applyRouteSet,
  setRouteLock,
  setRouteLockScope,
  toggleRouteLockRoute
} from '../../lib/actions/route-lock'
import { FETCH_STATUS } from '../../lib/util/constants'
// The jest stand-in for util/debug-log keeps what was recorded.
import { recordedSessionEvents } from '../test-utils/mock-data/debug-log'

// Count searches instead of running them: setQueryParam(patch, searchId)
// dispatches routingQuery(searchId), and that is "one search".
jest.mock('../../lib/actions/api', () => ({
  ...jest.requireActual('../../lib/actions/api'),
  routingQuery: (searchId: string) => ({
    payload: searchId,
    type: 'TEST_ROUTING_QUERY'
  })
}))

// A slice of the real graph: two feeds, and a METRO line with no shortName.
const ROUTES = {
  '1:18': { longName: null, shortName: '18', sortOrder: 18 },
  '1:904': { longName: 'METRO Orange Line', shortName: null, sortOrder: 4 },
  '1:921': { longName: 'METRO A Line', shortName: null, sortOrder: 21 },
  '2:425': {
    longName: 'Orange LINK',
    shortName: 'Orange LINK',
    sortOrder: 425
  }
}

/**
 * Run a route-lock thunk against a fake store and return the query patch it
 * dispatched (setQueryParam's first argument). The query is deliberately
 * INVALID (no from/to) so nothing tries to re-plan — this asserts the shape of
 * the lock, not the search that follows it.
 */
async function dispatched(thunk: any, currentQuery: any = {}) {
  const state = {
    otp: {
      config: {},
      currentQuery,
      transitIndex: { routes: ROUTES, routesFetchStatus: FETCH_STATUS.FETCHED }
    }
  }
  const patches: any[] = []
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, () => state)
    if (action?.type === 'SET_QUERY_PARAM') patches.push(action.payload)
    return action
  }
  await dispatch(thunk)
  return patches
}

describe('setRouteLock', () => {
  it('bans the complement of a SET, not of one route (rider ask #46)', async () => {
    const [patch] = await dispatched(setRouteLock(['1:18', '1:904']))
    const banned = patch.banned.routes.split(',')
    expect(banned).not.toContain('1:18')
    expect(banned).not.toContain('1:904')
    expect(banned).toEqual(expect.arrayContaining(['1:921', '2:425']))
    expect(patch.routeLock.routes.map((r: any) => r.id)).toEqual([
      '1:18',
      '1:904'
    ])
    expect(patch.routeLock.scope).toBe('only')
  })

  it('labels each route the way the rider names it', async () => {
    const [patch] = await dispatched(setRouteLock(['1:18', '1:904']))
    expect(patch.routeLock.routes.map((r: any) => r.label)).toEqual([
      '18',
      'METRO Orange Line'
    ])
  })

  it('still takes a single id', async () => {
    const [patch] = await dispatched(setRouteLock('1:18'))
    expect(patch.routeLock.routes).toEqual([{ id: '1:18', label: '18' }])
  })

  it('drops ids the graph does not have rather than widening the ban', async () => {
    // An unknown id would be kept out of the complement and match nothing, so
    // the ban would silently be over a route that does not exist.
    const [patch] = await dispatched(setRouteLock(['1:18', '9:999']))
    expect(patch.routeLock.routes).toHaveLength(1)
    expect(patch.banned.routes.split(',')).not.toContain('9:999')
  })

  it('never bans anything for a starting route (rider ask #45)', async () => {
    // A ban list cannot express "first leg only": banning the complement would
    // also forbid the connections the rider deliberately left free.
    const [patch] = await dispatched(setRouteLock(['1:18'], 'starting'))
    expect(patch.banned).toBeUndefined()
    expect(patch.modes).toBeUndefined()
    expect(patch.routeLock.scope).toBe('starting')
  })

  it('biases the query toward a starting route instead', async () => {
    const [patch] = await dispatched(
      setRouteLock(['1:18', '1:904'], 'starting')
    )
    expect(patch.preferred).toEqual({
      otherThanPreferredRoutesPenalty: 900,
      routes: '1:18,1:904'
    })
  })

  it('leaves the rider’s modes and levers alone for a starting route', async () => {
    // "Only the 18" means "bike the rest", so it pins modes and raises bike
    // reluctance. "Start me on the 18" says nothing of the kind.
    const [patch] = await dispatched(setRouteLock(['1:18'], 'starting'), {
      routingPreferences: { bikeReluctance: 0.5 }
    })
    expect(patch.routingPreferences).toBeUndefined()
  })

  it('raises bike reluctance only for a whole-trip lock', async () => {
    const [patch] = await dispatched(setRouteLock(['1:18']), {
      routingPreferences: { bikeReluctance: 0.5 }
    })
    expect(patch.routingPreferences.bikeReluctance).toBeGreaterThanOrEqual(10)
    expect(patch.modes).toEqual([{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }])
  })

  it('releases everything it set', async () => {
    const [patch] = await dispatched(setRouteLock(null))
    expect(patch).toEqual({
      banned: undefined,
      modes: undefined,
      preferred: undefined,
      routeLock: undefined
    })
  })

  it('treats an empty set as a release', async () => {
    const [patch] = await dispatched(setRouteLock([]))
    expect(patch.routeLock).toBeUndefined()
  })
})

describe('toggleRouteLockRoute', () => {
  const lockedTo18 = {
    routeLock: { routes: [{ id: '1:18', label: '18' }], scope: 'only' }
  }

  it('adds a second route without losing the first', async () => {
    const [patch] = await dispatched(toggleRouteLockRoute('1:904'), lockedTo18)
    expect(patch.routeLock.routes.map((r: any) => r.id)).toEqual([
      '1:18',
      '1:904'
    ])
  })

  it('removes a route that is already named', async () => {
    const [patch] = await dispatched(toggleRouteLockRoute('1:18'), {
      routeLock: {
        routes: [
          { id: '1:18', label: '18' },
          { id: '1:904', label: 'METRO Orange Line' }
        ],
        scope: 'only'
      }
    })
    expect(patch.routeLock.routes.map((r: any) => r.id)).toEqual(['1:904'])
  })

  it('releases the lock when the last route is removed', async () => {
    const [patch] = await dispatched(toggleRouteLockRoute('1:18'), lockedTo18)
    expect(patch.routeLock).toBeUndefined()
    expect(patch.banned).toBeUndefined()
  })

  it('keeps the scope the rider chose', async () => {
    const [patch] = await dispatched(toggleRouteLockRoute('1:904'), {
      routeLock: { routes: [{ id: '1:18', label: '18' }], scope: 'starting' }
    })
    expect(patch.routeLock.scope).toBe('starting')
    expect(patch.banned).toBeUndefined()
  })
})

describe('setRouteLockScope', () => {
  it('swaps a whole-trip lock for a starting route, keeping the routes', async () => {
    const [patch] = await dispatched(setRouteLockScope('starting'), {
      routeLock: {
        routes: [
          { id: '1:18', label: '18' },
          { id: '1:904', label: 'METRO Orange Line' }
        ],
        scope: 'only'
      }
    })
    expect(patch.routeLock.scope).toBe('starting')
    expect(patch.routeLock.routes).toHaveLength(2)
    // The ban has to come OFF, or "starting" would still be a whole-trip lock.
    expect(patch.banned).toBeUndefined()
  })

  it('does nothing when no route is named', async () => {
    expect(await dispatched(setRouteLockScope('starting'), {})).toHaveLength(0)
  })
})

/**
 * Like `dispatched`, over a VALID query (both ends set), so a write that
 * re-searches really would: returns the patches and how many searches ran.
 */
async function run(thunk: any, currentQuery: any = {}) {
  const state = {
    otp: {
      config: {},
      currentQuery: {
        from: { lat: 44.8168, lon: -93.3102, name: 'Home' },
        to: { lat: 45.0, lon: -92.9489, name: 'Oakdale' },
        ...currentQuery
      },
      transitIndex: { routes: ROUTES, routesFetchStatus: FETCH_STATUS.FETCHED }
    }
  }
  const patches: any[] = []
  let searches = 0
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, () => state)
    if (action?.type === 'SET_QUERY_PARAM') patches.push(action.payload)
    if (action?.type === 'TEST_ROUTING_QUERY') searches += 1
    return action
  }
  const result = await dispatch(thunk)
  return { patches, result, searches: () => searches }
}

describe('writes from inside Settings do not search (58.2, cycle 27 Q2)', () => {
  const lockedTo18And904 = {
    routeLock: {
      routes: [
        { id: '1:18', label: '18' },
        { id: '1:904', label: 'METRO Orange Line' }
      ],
      scope: 'only'
    }
  }

  it('searches once by default — the control case', async () => {
    const { searches } = await run(setRouteLock(['1:18', '1:904']))
    expect(searches()).toBe(1)
  })

  it('writes the set but runs no search with replan: false', async () => {
    const { patches, searches } = await run(
      setRouteLock(['1:18', '1:904'], 'only', { replan: false })
    )
    expect(searches()).toBe(0)
    expect(patches[0].routeLock.routes).toHaveLength(2)
  })

  it('removes a chip without a search', async () => {
    const { patches, searches } = await run(
      toggleRouteLockRoute('1:18', { replan: false }),
      lockedTo18And904
    )
    expect(searches()).toBe(0)
    expect(patches[0].routeLock.routes.map((r: any) => r.id)).toEqual(['1:904'])
  })

  it('switches scope without a search', async () => {
    const { searches } = await run(
      setRouteLockScope('starting', { replan: false }),
      lockedTo18And904
    )
    expect(searches()).toBe(0)
  })

  it('releases without a search', async () => {
    const { patches, searches } = await run(
      setRouteLock(null, 'only', { replan: false }),
      lockedTo18And904
    )
    expect(searches()).toBe(0)
    expect(patches[0].routeLock).toBeUndefined()
  })
})

describe('a lock from before 2026-09-02 (one route, no list)', () => {
  const legacy = { routeLock: { id: '1:18', label: '18' } }

  it('is added to rather than dropped', async () => {
    const { patches } = await run(toggleRouteLockRoute('1:904'), legacy)
    expect(patches[0].routeLock.routes.map((r: any) => r.id)).toEqual([
      '1:18',
      '1:904'
    ])
    expect(patches[0].routeLock.scope).toBe('only')
  })

  it('can change scope without throwing', async () => {
    const { patches } = await run(setRouteLockScope('starting'), legacy)
    expect(patches[0].routeLock).toEqual({
      routes: [{ id: '1:18', label: '18' }],
      scope: 'starting'
    })
  })
})

describe('applyRouteSet telemetry', () => {
  beforeEach(() => {
    recordedSessionEvents.length = 0
  })

  it('records ROUTE_SET_APPLIED with the count, scope and source', async () => {
    await run(applyRouteSet(['1:18', '1:904', '1:921'], 'only', 'sheet'))
    expect(recordedSessionEvents).toEqual([
      { count: 3, event: 'ROUTE_SET_APPLIED', scope: 'only', source: 'sheet' }
    ])
  })

  it('counts only the routes the graph has, and a release as 0', async () => {
    await run(applyRouteSet(['1:18', '9:999'], 'starting', 'saved'))
    await run(applyRouteSet([], 'only', 'sheet'))
    expect(recordedSessionEvents).toEqual([
      {
        count: 1,
        event: 'ROUTE_SET_APPLIED',
        scope: 'starting',
        source: 'saved'
      },
      { count: 0, event: 'ROUTE_SET_APPLIED', scope: 'only', source: 'sheet' }
    ])
  })

  it('passes replan through', async () => {
    const { searches } = await run(
      applyRouteSet(['1:18'], 'only', 'sheet', { replan: false })
    )
    expect(searches()).toBe(0)
  })
})

describe('applyRouteLocksFromText (cycle 27 Q5, Q7)', () => {
  beforeEach(() => {
    recordedSessionEvents.length = 0
  })

  it('holds the search to every route named, in ONE write and ONE search', async () => {
    const { patches, result, searches } = await run(
      applyRouteLocksFromText(['18', 'Orange Line'])
    )
    expect(patches).toHaveLength(1)
    expect(searches()).toBe(1)
    expect(patches[0].routeLock.routes.map((r: any) => r.id)).toEqual([
      '1:18',
      '1:904'
    ])
    expect(result).toEqual({
      locks: [
        { id: '1:18', label: '18' },
        { id: '1:904', label: 'METRO Orange Line' }
      ],
      missing: []
    })
    expect(recordedSessionEvents).toEqual([
      {
        count: 2,
        event: 'ROUTE_SET_APPLIED',
        scope: 'only',
        source: 'describe'
      }
    ])
  })

  it('locks what it found and names what it did not', async () => {
    const { patches, result } = await run(applyRouteLocksFromText(['18', '99']))
    expect(patches[0].routeLock.routes.map((r: any) => r.id)).toEqual(['1:18'])
    expect(result.missing).toEqual(['99'])
  })

  it('touches nothing when no name matches', async () => {
    const { patches, result, searches } = await run(
      applyRouteLocksFromText(['99', 'Purple Line'])
    )
    expect(patches).toHaveLength(0)
    expect(searches()).toBe(0)
    expect(result).toEqual({ locks: [], missing: ['99', 'Purple Line'] })
    expect(recordedSessionEvents).toHaveLength(0)
  })

  it('REPLACES a set already in place (Q7 = A)', async () => {
    const { patches } = await run(applyRouteLocksFromText(['18']), {
      routeLock: {
        routes: [{ id: '1:921', label: 'METRO A Line' }],
        scope: 'starting'
      }
    })
    expect(patches[0].routeLock).toEqual({
      routes: [{ id: '1:18', label: '18' }],
      scope: 'only'
    })
  })

  it('adds to the set only when asked to', async () => {
    const { patches } = await run(applyRouteLocksFromText(['18'], 'add'), {
      routeLock: {
        routes: [{ id: '1:921', label: 'METRO A Line' }],
        scope: 'only'
      }
    })
    expect(patches[0].routeLock.routes.map((r: any) => r.id)).toEqual([
      '1:921',
      '1:18'
    ])
  })

  it('counts two names for the same route once', async () => {
    const { result } = await run(
      applyRouteLocksFromText(['Orange Line', 'METRO Orange Line'])
    )
    expect(result.locks).toEqual([{ id: '1:904', label: 'METRO Orange Line' }])
  })
})
