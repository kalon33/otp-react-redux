import {
  mergePlaces,
  parsePlacesSnapshot,
  readPlacesSnapshot,
  readPlacesState
} from '../../lib/util/places-state'

const GYM = {
  address: '456 Barbell Ave',
  icon: 'map-marker',
  id: 'place-gym1',
  lat: 44.9,
  lon: -93.2,
  name: 'Gym',
  type: 'custom'
}
const MOMS = { ...GYM, address: '12 Rose Ln', id: 'place-moms1', name: "Mom's" }
const HOME = { lat: 44.95, lon: -93.25, name: '1 Home St', type: 'home' }
const WORK = { lat: 44.97, lon: -93.27, name: '9 Work Ave', type: 'work' }
const SERVER_HOME = { ...HOME, name: '2 Other St' }

const store = (key: string, value: unknown) =>
  window.localStorage.setItem(`otp.${key}`, JSON.stringify(value))

describe('lib > util > places-state', () => {
  afterEach(() => window.localStorage.clear())

  describe('readPlacesState (the PLACES_STATE counts)', () => {
    it('reports counts and key presence only — no names, no coordinates', () => {
      store('savedPlaces', [GYM, MOMS])
      store('home', HOME)
      store('recent', [{ lat: 1, lon: 2, name: 'x' }])
      const state = readPlacesState()
      expect(state).toEqual({
        dropped: 0,
        home: true,
        keys: ['otp.savedPlaces', 'otp.home', 'otp.recent'],
        recent: 1,
        saved: 2,
        work: false
      })
      const text = JSON.stringify(state)
      expect(text).not.toContain('Barbell')
      expect(text).not.toContain('Gym')
      expect(text).not.toContain('44.9')
    })

    it('reports an empty phone as empty, with no keys', () => {
      expect(readPlacesState()).toEqual({
        dropped: 0,
        home: false,
        keys: [],
        recent: 0,
        saved: 0,
        work: false
      })
    })

    it('counts stored entries the loader would throw away', () => {
      store('savedPlaces', [GYM, { ...MOMS, lat: '44.8' }, { name: 'no id' }])
      expect(readPlacesState()).toMatchObject({ dropped: 2, saved: 1 })
    })

    it('distinguishes an EMPTY key from a missing one', () => {
      store('savedPlaces', [])
      expect(readPlacesState()).toMatchObject({
        keys: ['otp.savedPlaces'],
        saved: 0
      })
    })
  })

  describe('parsePlacesSnapshot', () => {
    it('drops malformed and non-custom entries from the server', () => {
      expect(
        parsePlacesSnapshot({
          home: { name: 'no coords' },
          places: [GYM, { ...MOMS, id: '' }, { ...HOME, id: 'h' }, null],
          work: WORK
        })
      ).toEqual({ home: null, places: [GYM], work: WORK })
      expect(parsePlacesSnapshot(null)).toEqual({
        home: null,
        places: [],
        work: null
      })
    })
  })

  describe('mergePlaces', () => {
    const empty = { home: null, places: [], work: null }

    it('restores every key that is missing or empty locally', () => {
      const server = { home: HOME, places: [GYM, MOMS], work: WORK }
      const result = mergePlaces(empty, server)
      expect(result.merged).toEqual(server)
      expect(result.restored).toEqual({ home: true, places: 2, work: true })
      expect(result.aheadOfServer).toBe(false)
    })

    it('local wins on conflict by id, and for home/work', () => {
      const renamed = { ...GYM, name: 'Iron temple' }
      const result = mergePlaces(
        { home: HOME, places: [renamed], work: null },
        { home: SERVER_HOME, places: [GYM], work: WORK }
      )
      expect(result.merged).toEqual({
        home: HOME,
        places: [renamed],
        work: WORK
      })
      expect(result.restored).toEqual({ home: false, places: 0, work: true })
      // The local edit is not on the server yet.
      expect(result.aheadOfServer).toBe(true)
    })

    it('never overwrites a non-empty local list; a server-only place is added', () => {
      const result = mergePlaces(
        { ...empty, places: [GYM] },
        { ...empty, places: [MOMS] }
      )
      expect(result.merged.places).toEqual([GYM, MOMS])
      expect(result.restored.places).toBe(1)
      expect(result.aheadOfServer).toBe(true)
    })

    it('an empty server copy changes nothing locally', () => {
      const local = { home: HOME, places: [GYM], work: null }
      const result = mergePlaces(local, empty)
      expect(result.merged).toEqual(local)
      expect(result.restored).toEqual({ home: false, places: 0, work: false })
      expect(result.aheadOfServer).toBe(true)
    })

    it('an unacknowledged local write is authoritative: no resurrection', () => {
      // The rider deleted Mom's and Home; the POST never landed.
      const result = mergePlaces(
        { ...empty, places: [GYM] },
        { home: HOME, places: [GYM, MOMS], work: null },
        true
      )
      expect(result.merged).toEqual({ ...empty, places: [GYM] })
      expect(result.restored).toEqual({ home: false, places: 0, work: false })
      expect(result.aheadOfServer).toBe(true)
    })
  })

  describe('saved route sets ride along (58.2, cycle 27 Q6 = B)', () => {
    const empty = { home: null, places: [], work: null }
    const COMMUTE = {
      id: 'set-commute',
      name: 'Commute',
      routes: [
        { id: '1:18', label: '18' },
        { id: '1:21', label: '21' }
      ],
      savedAt: 1,
      scope: 'only' as const
    }
    const GYM_SET = { ...COMMUTE, id: 'set-gym', name: 'Gym' }

    it('the snapshot the phone POSTs carries its sets', () => {
      store('routeSets', [COMMUTE, { junk: true }])
      expect(readPlacesSnapshot().routeSets).toEqual([COMMUTE])
    })

    it('a server answer with no routeSets key says nothing about sets', () => {
      expect('routeSets' in parsePlacesSnapshot({ places: [] })).toBe(false)
      expect(
        parsePlacesSnapshot({ places: [], routeSets: [COMMUTE, 'x'] }).routeSets
      ).toEqual([COMMUTE])
      expect(
        parsePlacesSnapshot({ places: [], routeSets: 'nope' }).routeSets
      ).toEqual([])
    })

    it('an OLD server (no key) leaves the local sets intact and is not "behind"', () => {
      const local = { ...empty, places: [GYM], routeSets: [COMMUTE] }
      const result = mergePlaces(
        local,
        parsePlacesSnapshot({ ...empty, places: [GYM] })
      )
      expect(result.merged.routeSets).toEqual([COMMUTE])
      expect(result.restored).toEqual({ home: false, places: 0, work: false })
      // No POST every launch at a server that will never keep sets.
      expect(result.aheadOfServer).toBe(false)
    })

    it('a wiped phone gets its sets back; a set on both sides keeps the local copy', () => {
      const renamed = { ...COMMUTE, name: 'Work run' }
      const result = mergePlaces(
        { ...empty, routeSets: [renamed] },
        { ...empty, routeSets: [COMMUTE, GYM_SET] }
      )
      expect(result.merged.routeSets).toEqual([renamed, GYM_SET])
      expect(result.restored).toEqual({
        home: false,
        places: 0,
        routeSets: 1,
        work: false
      })
      expect(result.aheadOfServer).toBe(true)

      const wiped = mergePlaces(
        { ...empty, routeSets: [] },
        { ...empty, routeSets: [COMMUTE, GYM_SET] }
      )
      expect(wiped.merged.routeSets).toEqual([COMMUTE, GYM_SET])
      expect(wiped.restored.routeSets).toBe(2)
      expect(wiped.aheadOfServer).toBe(false)
    })

    it('a server set whose name a local set took is dropped, not doubled', () => {
      const local = { ...empty, routeSets: [{ ...GYM_SET, name: 'commute' }] }
      const result = mergePlaces(local, { ...empty, routeSets: [COMMUTE] })
      expect(result.merged.routeSets).toEqual(local.routeSets)
      expect(result.restored.routeSets).toBeUndefined()
    })

    it('an unacknowledged local delete is not undone by the server copy', () => {
      const result = mergePlaces(
        { ...empty, routeSets: [] },
        { ...empty, routeSets: [COMMUTE] },
        true
      )
      expect(result.merged.routeSets).toEqual([])
      expect(result.aheadOfServer).toBe(true)
    })
  })
})
