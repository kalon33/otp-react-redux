import { FETCH_STATUS } from '../../lib/util/constants'
import {
  setRouteLock,
  setRouteLockScope,
  toggleRouteLockRoute
} from '../../lib/actions/route-lock'

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
