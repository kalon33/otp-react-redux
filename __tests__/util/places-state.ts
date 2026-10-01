import {
  mergePlaces,
  parsePlacesSnapshot,
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
})
