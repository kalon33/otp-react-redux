import {
  cleanSetName,
  deleteRouteSet,
  loadRouteSets,
  matchSavedSet,
  MAX_ROUTE_SETS,
  MAX_ROUTES_PER_SET,
  parseRouteSets,
  persistRouteSets,
  renameRouteSet,
  RouteSet,
  splitRunningRoutes,
  upsertRouteSet
} from '../../lib/util/route-sets'

const R18 = { id: '1:18', label: '18' }
const R21 = { id: '1:21', label: '21' }
const ORANGE = { id: '1:904', label: 'Orange' }

const COMMUTE: RouteSet = {
  id: 'set-commute',
  name: 'Commute',
  routes: [R18, R21, ORANGE],
  savedAt: 1000,
  scope: 'only'
}
const GYM: RouteSet = {
  id: 'set-gym',
  name: 'Gym',
  routes: [R21],
  savedAt: 2000,
  scope: 'starting'
}

describe('lib > util > route-sets (58.2 saved sets)', () => {
  afterEach(() => window.localStorage.clear())

  describe('loadRouteSets / parseRouteSets: garbage in, [] out, never a throw', () => {
    it.each([
      ['missing key', undefined],
      ['not JSON', '{nope'],
      ['a number', '42'],
      ['an object', '{"id":"x"}'],
      ['a string', '"Commute"'],
      ['null', 'null'],
      ['a list of junk', '[null, 1, "a", [], {}]']
    ])('%s → []', (_, raw) => {
      if (raw !== undefined) window.localStorage.setItem('otp.routeSets', raw)
      expect(() => loadRouteSets()).not.toThrow()
      expect(loadRouteSets()).toEqual([])
    })

    it('a value whose getters throw is dropped, not fatal', () => {
      const hostile = {}
      Object.defineProperty(hostile, 'id', {
        get() {
          throw new Error('boom')
        }
      })
      expect(parseRouteSets([hostile, COMMUTE])).toEqual([COMMUTE])
    })

    it('keeps good sets and drops each kind of bad one', () => {
      const raw = [
        COMMUTE,
        { ...GYM, scope: 'sometimes' }, // unknown scope
        { ...GYM, id: '', name: 'No id' },
        { ...GYM, id: 'set-blank', name: '   ' },
        { ...GYM, id: 'set-noroutes', name: 'Empty', routes: [] },
        { ...GYM, id: 'set-badroutes', name: 'Bad', routes: [{}, null, 5] },
        // Legacy/foreign shape: a single route, no routes array.
        { id: 'set-legacy', label: '18', name: 'Old' },
        GYM
      ]
      expect(parseRouteSets(raw)).toEqual([COMMUTE, GYM])
    })

    it('a route with no label is labelled by its id; dupes in a set collapse', () => {
      const [set] = parseRouteSets([
        { ...COMMUTE, routes: [{ id: '1:18' }, R18, { id: '1:5', label: '' }] }
      ])
      expect(set.routes).toEqual([
        { id: '1:18', label: '1:18' },
        { id: '1:5', label: '1:5' }
      ])
    })

    it('a missing savedAt reads as 0, and the result round-trips storage', () => {
      const { savedAt, ...noTime } = COMMUTE // eslint-disable-line @typescript-eslint/no-unused-vars
      persistRouteSets(parseRouteSets([noTime]))
      expect(loadRouteSets()).toEqual([{ ...COMMUTE, savedAt: 0 }])
    })

    it('ids and names are unique on the way in (first wins, names ignore case)', () => {
      expect(
        parseRouteSets([
          COMMUTE,
          { ...GYM, id: COMMUTE.id },
          { ...GYM, id: 'set-x', name: 'COMMUTE' },
          GYM
        ])
      ).toEqual([COMMUTE, GYM])
    })
  })

  describe('caps', () => {
    it(`at most ${MAX_ROUTE_SETS} sets are read back`, () => {
      const many = Array.from({ length: 25 }, (_, i) => ({
        ...COMMUTE,
        id: `set-${i}`,
        name: `Set ${i}`
      }))
      expect(parseRouteSets(many)).toHaveLength(MAX_ROUTE_SETS)
    })

    it('a 21st save is refused as full', () => {
      let sets: RouteSet[] = []
      for (let i = 0; i < MAX_ROUTE_SETS; i++) {
        const result = upsertRouteSet(sets, {
          name: `Set ${i}`,
          routes: [R18],
          scope: 'only'
        })
        if (!result.ok) throw new Error(result.error)
        sets = result.sets
      }
      expect(
        upsertRouteSet(sets, { name: 'One more', routes: [R18], scope: 'only' })
      ).toEqual({ error: 'full', ok: false })
      // Replacing one is still allowed when full.
      const replaced = upsertRouteSet(
        sets,
        { name: 'set 3', routes: [R21], scope: 'only' },
        { replace: true }
      )
      expect(replaced.ok).toBe(true)
    })

    it(`at most ${MAX_ROUTES_PER_SET} routes per set`, () => {
      const routes = Array.from({ length: 40 }, (_, i) => ({
        id: `1:${i}`,
        label: `${i}`
      }))
      const result = upsertRouteSet([], { name: 'Big', routes, scope: 'only' })
      expect(result.ok && result.set.routes).toHaveLength(MAX_ROUTES_PER_SET)
    })

    it('names are trimmed, inner spaces collapsed, cut at 40', () => {
      expect(cleanSetName('  My   commute  ')).toBe('My commute')
      expect(cleanSetName('x'.repeat(60))).toHaveLength(40)
      expect(cleanSetName(42)).toBe('')
      const result = upsertRouteSet([], {
        name: `  ${'a'.repeat(50)} `,
        routes: [R18],
        scope: 'only'
      })
      expect(result.ok && result.set.name).toBe('a'.repeat(40))
    })
  })

  describe('upsertRouteSet', () => {
    it('a new set goes first, with the id and time given', () => {
      const result = upsertRouteSet(
        [GYM],
        { name: 'Commute', routes: [R18, R21, ORANGE], scope: 'only' },
        { id: 'set-commute', now: 1000 }
      )
      expect(result).toEqual({
        ok: true,
        replaced: false,
        set: COMMUTE,
        sets: [COMMUTE, GYM]
      })
    })

    it('a taken name (any case) is refused with the set it clashes with', () => {
      expect(
        upsertRouteSet([COMMUTE], {
          name: 'commute',
          routes: [R18],
          scope: 'only'
        })
      ).toEqual({ error: 'exists', existing: COMMUTE, ok: false })
    })

    it('replace keeps the id and the spot, takes the new routes and scope', () => {
      const result = upsertRouteSet(
        [GYM, COMMUTE],
        { name: 'commute', routes: [R21], scope: 'starting' },
        { now: 5000, replace: true }
      )
      expect(result.ok && result.replaced).toBe(true)
      expect(result.ok && result.sets).toEqual([
        GYM,
        {
          id: 'set-commute',
          name: 'commute',
          routes: [R21],
          savedAt: 5000,
          scope: 'starting'
        }
      ])
    })

    it('a blank name or no routes is refused', () => {
      expect(
        upsertRouteSet([], { name: '  ', routes: [R18], scope: 'only' })
      ).toEqual({ error: 'noName', ok: false })
      expect(
        upsertRouteSet([], { name: 'X', routes: [], scope: 'only' })
      ).toEqual({ error: 'noRoutes', ok: false })
    })
  })

  describe('renameRouteSet / deleteRouteSet', () => {
    it('renames in place; a name another set has is refused', () => {
      const ok = renameRouteSet([COMMUTE, GYM], 'set-gym', ' Lifting ', 9)
      expect(ok.ok && ok.sets[1]).toEqual({
        ...GYM,
        name: 'Lifting',
        savedAt: 9
      })
      expect(renameRouteSet([COMMUTE, GYM], 'set-gym', 'COMMUTE')).toEqual({
        error: 'exists',
        existing: COMMUTE,
        ok: false
      })
      // A set may be renamed to its own name in a new case.
      expect(renameRouteSet([COMMUTE], 'set-commute', 'commute').ok).toBe(true)
      expect(renameRouteSet([COMMUTE], 'nope', 'X')).toEqual({
        error: 'missing',
        ok: false
      })
    })

    it('delete drops by id; an unknown id returns the same list', () => {
      const sets = [COMMUTE, GYM]
      expect(deleteRouteSet(sets, 'set-commute')).toEqual([GYM])
      expect(deleteRouteSet(sets, 'nope')).toBe(sets)
    })
  })

  describe('matchSavedSet', () => {
    const lock = (routes: { id: string; label: string }[], scope = 'only') => ({
      routes,
      scope: scope as 'only' | 'starting'
    })

    it('same ids in any order and the same scope', () => {
      expect(matchSavedSet(lock([ORANGE, R18, R21]), [GYM, COMMUTE])).toBe(
        COMMUTE
      )
    })

    it('a different scope, a subset or a superset is no match', () => {
      expect(
        matchSavedSet(lock([R18, R21, ORANGE], 'starting'), [COMMUTE])
      ).toBeUndefined()
      expect(matchSavedSet(lock([R18, R21]), [COMMUTE])).toBeUndefined()
      expect(
        matchSavedSet(lock([R18, R21, ORANGE, { id: '1:5', label: '5' }]), [
          COMMUTE
        ])
      ).toBeUndefined()
    })

    it('a pre-09-02 single-route lock matches a one-route "only" set', () => {
      const one = { ...GYM, scope: 'only' as const }
      expect(matchSavedSet({ id: '1:21', label: '21' }, [one])).toBe(one)
    })

    it('no lock or no sets: no match', () => {
      expect(matchSavedSet(null, [COMMUTE])).toBeUndefined()
      expect(matchSavedSet(lock([R18]), undefined)).toBeUndefined()
    })
  })

  describe('splitRunningRoutes', () => {
    it('names the routes the graph no longer has', () => {
      expect(splitRunningRoutes(COMMUTE, { '1:18': {}, '1:904': {} })).toEqual({
        missing: [R21],
        running: [R18, ORANGE]
      })
    })

    it('with no index yet, calls nothing missing', () => {
      expect(splitRunningRoutes(COMMUTE, {})).toEqual({
        missing: [],
        running: COMMUTE.routes
      })
      expect(splitRunningRoutes(COMMUTE, undefined).missing).toEqual([])
    })
  })
})
