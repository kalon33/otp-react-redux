import {
  applyRouteLockToItineraries,
  buildBannedRoutes,
  firstTransitRouteId,
  itineraryMatchesLock,
  itineraryStartsOnRoute,
  itineraryUsesRoute,
  resolveRouteLock,
  ROUTE_LOCK_MIN_BIKE_RELUCTANCE,
  routeLockLabel,
  routeLockText,
  withRouteLockPrefs
} from '../../lib/util/route-lock'
import type { RouteLock } from '../../lib/util/route-lock'

// A slice of the real Twin Cities graph, including the things that make route
// naming awkward: METRO lines carry no shortName, the suburban operator is a
// second feed, and "Orange" is the start of two different route names.
const ROUTES = {
  '1:118': { longName: null, shortName: '118', sortOrder: 118 },
  '1:18': { longName: null, shortName: '18', sortOrder: 18 },
  '1:904': { longName: 'METRO Orange Line', shortName: null, sortOrder: 4 },
  '1:921': { longName: 'METRO A Line', shortName: null, sortOrder: 21 },
  '2:425': {
    longName: 'Orange LINK: Apple Valley-Burnsville-Eag',
    shortName: 'Orange LINK',
    sortOrder: 425
  }
}

describe('resolveRouteLock', () => {
  it('matches a numbered route exactly', () => {
    expect(resolveRouteLock(ROUTES, '18')).toEqual({ id: '1:18', label: '18' })
  })

  it('does not let a numbered route match a longer number', () => {
    // "18" must never resolve to the 118 — an exact short-name hit always wins.
    expect(resolveRouteLock(ROUTES, '18')?.id).not.toBe('1:118')
  })

  it('matches a METRO line by name, case-insensitively', () => {
    expect(resolveRouteLock(ROUTES, 'metro orange line')).toEqual({
      id: '1:904',
      label: 'METRO Orange Line'
    })
  })

  it('picks the closest name when a partial name matches several', () => {
    // "Orange Line" is a substring of neither route's name exactly, but it is
    // far closer to METRO Orange Line than to Orange LINK: Apple Valley...
    expect(resolveRouteLock(ROUTES, 'Orange Line')?.id).toBe('1:904')
  })

  it('returns null for a route the graph does not have', () => {
    expect(resolveRouteLock(ROUTES, 'Purple Line')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(resolveRouteLock(ROUTES, '   ')).toBeNull()
    expect(resolveRouteLock(undefined, '18')).toBeNull()
  })
})

describe('routeLockLabel', () => {
  it('prefers the short name riders use', () => {
    expect(routeLockLabel(ROUTES['1:18'])).toBe('18')
  })

  it('falls back to the long name for routes without one', () => {
    expect(routeLockLabel(ROUTES['1:904'])).toBe('METRO Orange Line')
  })
})

describe('buildBannedRoutes', () => {
  it('bans every route except the one being kept', () => {
    const banned = buildBannedRoutes(ROUTES, '1:18').split(',')
    expect(banned).not.toContain('1:18')
    expect(banned.sort()).toEqual(['1:118', '1:904', '1:921', '2:425'])
  })

  it('covers every feed in the graph', () => {
    // A route left off this list stays legal for the planner to use, so the
    // second feed's routes must be banned too.
    expect(buildBannedRoutes(ROUTES, '1:18')).toContain('2:425')
  })

  it('is empty when the graph holds only the kept route', () => {
    expect(buildBannedRoutes({ '1:18': ROUTES['1:18'] }, '1:18')).toBe('')
  })
})

describe('itineraryUsesRoute', () => {
  const biked = { legs: [{ mode: 'BICYCLE' }] }
  const rode = {
    legs: [
      { mode: 'BICYCLE' },
      { mode: 'BUS', route: { id: '1:18' } },
      { mode: 'BICYCLE' }
    ]
  }

  it('recognizes the locked route', () => {
    expect(itineraryUsesRoute(rode, '1:18')).toBe(true)
  })

  it('rejects the bike-the-whole-way option', () => {
    expect(itineraryUsesRoute(biked, '1:18')).toBe(false)
  })

  it('rejects a trip on some other route', () => {
    expect(itineraryUsesRoute(rode, '1:904')).toBe(false)
  })

  it('copes with a missing itinerary', () => {
    expect(itineraryUsesRoute(null, '1:18')).toBe(false)
  })
})

describe('withRouteLockPrefs', () => {
  it('supplies the floor when the rider set nothing', () => {
    expect(withRouteLockPrefs(undefined)).toEqual({
      bikeReluctance: ROUTE_LOCK_MIN_BIKE_RELUCTANCE
    })
  })

  it('raises a bike reluctance too low to let the route carry the trip', () => {
    // "I'll bike to the 18" reads to the preferences model as "prefer biking";
    // left at 0.1 the plan pedals past the route it was locked to.
    expect(withRouteLockPrefs({ bikeReluctance: 0.1 }).bikeReluctance).toBe(
      ROUTE_LOCK_MIN_BIKE_RELUCTANCE
    )
  })

  it('leaves a higher bike reluctance alone', () => {
    // Relative to the floor, not a literal: a rider who is already more
    // reluctant to pedal than the lock requires keeps their own value, whatever
    // the floor is raised to next.
    const above = ROUTE_LOCK_MIN_BIKE_RELUCTANCE + 1
    expect(withRouteLockPrefs({ bikeReluctance: above }).bikeReluctance).toBe(
      above
    )
  })

  it('keeps every other lever the rider chose', () => {
    expect(
      withRouteLockPrefs({ transferPenalty: 900, walkReluctance: 15 })
    ).toEqual({
      bikeReluctance: ROUTE_LOCK_MIN_BIKE_RELUCTANCE,
      transferPenalty: 900,
      walkReluctance: 15
    })
  })
})

// Rider ask #46: "use only these routes" — pick more than one.
describe('buildBannedRoutes over a set', () => {
  it('keeps every named route legal, not just the first', () => {
    const banned = buildBannedRoutes(ROUTES, ['1:18', '1:904']).split(',')
    expect(banned).not.toContain('1:18')
    expect(banned).not.toContain('1:904')
    expect(banned).toEqual(expect.arrayContaining(['1:118', '2:425', '1:921']))
  })

  it('still bans the complement across feeds', () => {
    expect(buildBannedRoutes(ROUTES, ['1:18', '1:921'])).toContain('2:425')
  })

  it('bans nothing at all rather than banning the whole graph', () => {
    // An empty selection is a released lock, never "forbid every route" — that
    // would answer a query with nothing and read as the app being broken.
    expect(buildBannedRoutes(ROUTES, [])).toBe('')
  })

  it('ignores empty ids mixed into the set', () => {
    expect(buildBannedRoutes(ROUTES, ['1:18', ''])).not.toContain('1:18')
  })
})

// Rider ask #45: "use as starting route", not "use only this route".
describe('first-leg constraint', () => {
  const eighteenThenOrange = {
    legs: [
      { mode: 'BICYCLE' },
      { mode: 'BUS', route: { id: '1:18' } },
      { mode: 'WALK' },
      { mode: 'BUS', route: { id: '1:904' } }
    ]
  }
  const orangeThenEighteen = {
    legs: [
      { mode: 'WALK' },
      { mode: 'BUS', route: { id: '1:904' } },
      { mode: 'WALK' },
      { mode: 'BUS', route: { id: '1:18' } }
    ]
  }
  const bikedAllTheWay = { legs: [{ mode: 'BICYCLE' }] }

  it('reads the first vehicle, not just any vehicle', () => {
    expect(firstTransitRouteId(eighteenThenOrange)).toBe('1:18')
    expect(firstTransitRouteId(orangeThenEighteen)).toBe('1:904')
    expect(firstTransitRouteId(bikedAllTheWay)).toBeNull()
  })

  it('accepts a trip that starts on the named route', () => {
    expect(itineraryStartsOnRoute(eighteenThenOrange, '1:18')).toBe(true)
  })

  it('rejects a trip that only reaches the named route later', () => {
    // This is the whole of the ask: "use only this route" would have taken
    // this trip, because it does ride the 18 — just not first.
    expect(itineraryUsesRoute(orangeThenEighteen, '1:18')).toBe(true)
    expect(itineraryStartsOnRoute(orangeThenEighteen, '1:18')).toBe(false)
  })

  it('rejects a trip that boards nothing', () => {
    expect(itineraryStartsOnRoute(bikedAllTheWay, '1:18')).toBe(false)
  })

  it('takes a set of starting routes', () => {
    expect(itineraryStartsOnRoute(orangeThenEighteen, ['1:18', '1:904'])).toBe(
      true
    )
  })
})

describe('itineraryMatchesLock', () => {
  const rode18Second = {
    legs: [
      { mode: 'BUS', route: { id: '1:904' } },
      { mode: 'BUS', route: { id: '1:18' } }
    ]
  }
  const only: RouteLock = {
    routes: [{ id: '1:18', label: '18' }],
    scope: 'only'
  }
  const starting: RouteLock = {
    routes: [{ id: '1:18', label: '18' }],
    scope: 'starting'
  }

  it('asks a different question for each scope', () => {
    expect(itineraryMatchesLock(rode18Second, only)).toBe(true)
    expect(itineraryMatchesLock(rode18Second, starting)).toBe(false)
  })

  it('matches everything when no routes are named', () => {
    expect(itineraryMatchesLock(rode18Second, undefined)).toBe(true)
    expect(
      itineraryMatchesLock(rode18Second, { routes: [], scope: 'only' })
    ).toBe(true)
  })
})

describe('routeLockText', () => {
  it('names every route in one phrase', () => {
    expect(
      routeLockText({
        routes: [
          { id: '1:18', label: '18' },
          { id: '1:904', label: 'METRO Orange Line' }
        ],
        scope: 'only'
      })
    ).toBe('18, METRO Orange Line')
  })
})

describe('applyRouteLockToItineraries', () => {
  const startsOn18 = {
    id: 'a',
    legs: [{ mode: 'BUS', route: { id: '1:18' } }]
  }
  const startsOnOrange = {
    id: 'b',
    legs: [{ mode: 'BUS', route: { id: '1:904' } }]
  }
  const biked = { id: 'c', legs: [{ mode: 'BICYCLE' }] }
  const list = [startsOnOrange, biked, startsOn18]

  it('partitions an "only these" lock without dropping anything', () => {
    const out = applyRouteLockToItineraries(list, {
      routes: [{ id: '1:18', label: '18' }],
      scope: 'only'
    })
    expect(out.map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })

  it('filters a starting-route lock down to the trips that start on it', () => {
    const out = applyRouteLockToItineraries(list, {
      routes: [{ id: '1:18', label: '18' }],
      scope: 'starting'
    })
    expect(out.map((i) => i.id)).toEqual(['a'])
  })

  it('keeps both named starting routes', () => {
    const out = applyRouteLockToItineraries(list, {
      routes: [
        { id: '1:18', label: '18' },
        { id: '1:904', label: 'METRO Orange Line' }
      ],
      scope: 'starting'
    })
    expect(out.map((i) => i.id)).toEqual(['b', 'a'])
  })

  it('shows the whole list rather than nothing when nothing complies', () => {
    // Narrowing to zero is not narrowing, it is a blank screen. The rows carry
    // their own "doesn't start on X" note instead.
    const out = applyRouteLockToItineraries(list, {
      routes: [{ id: '1:921', label: 'METRO A Line' }],
      scope: 'starting'
    })
    expect(out).toEqual(list)
  })

  it('leaves the list alone when no routes are named', () => {
    expect(applyRouteLockToItineraries(list, undefined)).toBe(list)
  })
})
