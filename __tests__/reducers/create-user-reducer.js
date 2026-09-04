import { restoreDateNowBehavior, setDefaultTestTime } from '../test-utils'
import createUserReducer, {
  getUserInitialState
} from '../../lib/reducers/create-user-reducer'

describe('lib > reducers > create-user-reducer', () => {
  afterEach(restoreDateNowBehavior)

  it('should be able to create the initial state', () => {
    setDefaultTestTime()
    expect(getUserInitialState({})).toMatchSnapshot()
  })

  describe('custom saved places (localStorage)', () => {
    const config = { persistence: { enabled: true, strategy: 'localStorage' } }
    const GYM = {
      address: '456 Barbell Ave',
      icon: 'map-marker',
      id: 'place-gym1',
      lat: 44.9,
      lon: -93.2,
      name: 'Gym',
      type: 'custom'
    }
    const MOMS = {
      address: '12 Rose Ln',
      icon: 'cutlery',
      id: 'place-moms1',
      lat: 44.8,
      lon: -93.3,
      name: "Mom's",
      type: 'dining'
    }
    const remember = (location) => ({
      payload: { location, type: location.type },
      type: 'REMEMBER_LOCAL_USER_PLACE'
    })
    const storedCustoms = () =>
      JSON.parse(window.localStorage.getItem('otp.savedPlaces') || '[]')
    const freshState = () => getUserInitialState(config)
    const reducer = createUserReducer(config)

    afterEach(() => window.localStorage.clear())

    it('a remembered custom place survives a reload (state and storage)', () => {
      const state = reducer(freshState(), remember(GYM))
      expect(state.localUser.savedLocations).toContainEqual(GYM)
      expect(storedCustoms()).toEqual([GYM])
      // "Reload": rebuilding initial state from localStorage keeps the place.
      expect(freshState().localUser.savedLocations).toContainEqual(GYM)
    })

    it('two custom places of the same type coexist', () => {
      const other = { ...GYM, id: 'place-gym2', name: 'Other gym' }
      let state = reducer(freshState(), remember(GYM))
      state = reducer(state, remember(other))
      expect(storedCustoms()).toHaveLength(2)
      expect(state.localUser.savedLocations).toEqual(
        expect.arrayContaining([GYM, other])
      )
    })

    it('re-remembering the same id replaces the place (edit)', () => {
      let state = reducer(freshState(), remember(GYM))
      const renamed = { ...GYM, name: 'Iron temple' }
      state = reducer(state, remember(renamed))
      expect(storedCustoms()).toEqual([renamed])
      expect(state.localUser.savedLocations).not.toContainEqual(GYM)
    })

    it('legacy home/work keys still load and still write', () => {
      window.localStorage.setItem(
        'otp.home',
        JSON.stringify({ lat: 1, lon: 2, name: '1 Home St', type: 'home' })
      )
      const state = reducer(freshState(), remember(GYM))
      expect(
        state.localUser.savedLocations.find((l) => l.type === 'home')?.address
      ).toEqual('1 Home St')
      // Remembering a custom place must not touch the home key.
      expect(JSON.parse(window.localStorage.getItem('otp.home')).name).toEqual(
        '1 Home St'
      )
      // Remembering home still writes the legacy key, not savedPlaces.
      const home = { lat: 3, lon: 4, name: '2 New Home Rd', type: 'home' }
      reducer(state, remember(home))
      expect(JSON.parse(window.localStorage.getItem('otp.home')).name).toEqual(
        '2 New Home Rd'
      )
      expect(storedCustoms()).toEqual([GYM])
    })

    it('config suggested locations never leak into otp.savedPlaces', () => {
      const configWithSuggested = {
        ...config,
        locations: [{ id: 'sug1', lat: 5, lon: 6, name: 'Library' }]
      }
      const state = getUserInitialState(configWithSuggested)
      createUserReducer(configWithSuggested)(state, remember(GYM))
      expect(storedCustoms()).toEqual([GYM])
    })

    it("deleting by the string 'home' clears state and storage", () => {
      window.localStorage.setItem(
        'otp.home',
        JSON.stringify({ lat: 1, lon: 2, name: '1 Home St', type: 'home' })
      )
      const state = reducer(freshState(), {
        payload: 'home',
        type: 'DELETE_LOCAL_USER_SAVED_PLACE'
      })
      expect(
        state.localUser.savedLocations.find((l) => l.type === 'home')
      ).toBeUndefined()
      expect(window.localStorage.getItem('otp.home')).toBeNull()
    })

    it('deleting a custom place object re-persists savedPlaces without it', () => {
      let state = reducer(freshState(), remember(GYM))
      state = reducer(state, remember(MOMS))
      state = reducer(state, {
        payload: GYM,
        type: 'DELETE_LOCAL_USER_SAVED_PLACE'
      })
      expect(storedCustoms()).toEqual([MOMS])
      expect(state.localUser.savedLocations).not.toContainEqual(GYM)
      expect(state.localUser.savedLocations).toContainEqual(MOMS)
    })

    it("custom place ids never contain 'recent' (forgetPlace routes on it)", () => {
      // The contract: ids are minted as `place-${randId()}`.
      expect(GYM.id.includes('recent')).toBe(false)
    })

    it('a custom place named "Home" is adopted into an empty home slot on load', () => {
      // What the rider's device actually held on 2026-09-04: a custom row
      // named "Home" and no otp.home key, so Saved places showed two Homes.
      const customHome = {
        address: '2345 Old Shakopee Road West',
        icon: 'map-marker',
        id: 'place-oldshak',
        lat: 44.8168,
        lon: -93.3102,
        name: 'Home',
        type: 'custom'
      }
      window.localStorage.setItem(
        'otp.savedPlaces',
        JSON.stringify([customHome])
      )
      const state = freshState()
      const homes = state.localUser.savedLocations.filter(
        (l) => l.type === 'home' || l.name === 'Home'
      )
      expect(homes).toHaveLength(1)
      expect(homes[0].type).toEqual('home')
      expect(homes[0].address).toEqual('2345 Old Shakopee Road West')
      expect(homes[0].icon).toEqual('home')
      // Persisted both ways: the legacy key is written and savedPlaces is
      // rewritten without the adopted row.
      expect(JSON.parse(window.localStorage.getItem('otp.home')).name).toEqual(
        '2345 Old Shakopee Road West'
      )
      expect(storedCustoms()).toEqual([])
      // Idempotent: a second load changes nothing.
      const reloaded = freshState()
      expect(reloaded.localUser.savedLocations).toEqual(
        state.localUser.savedLocations
      )
      expect(storedCustoms()).toEqual([])
    })

    it('an already-set home slot is never overwritten by a custom "Home"', () => {
      window.localStorage.setItem(
        'otp.home',
        JSON.stringify({ lat: 1, lon: 2, name: '1 Home St', type: 'home' })
      )
      const customHome = {
        address: '2345 Old Shakopee Road West',
        icon: 'map-marker',
        id: 'place-oldshak',
        lat: 44.8168,
        lon: -93.3102,
        name: 'Home',
        type: 'custom'
      }
      window.localStorage.setItem(
        'otp.savedPlaces',
        JSON.stringify([customHome])
      )
      const state = freshState()
      expect(
        state.localUser.savedLocations.find((l) => l.type === 'home').address
      ).toEqual('1 Home St')
      // The custom row survives — the rider still has both addresses.
      expect(storedCustoms()).toEqual([customHome])
      expect(state.localUser.savedLocations).toContainEqual(customHome)
    })

    it('remembering home fills address in state immediately (no reload needed)', () => {
      const state = reducer(freshState(), {
        payload: {
          location: { lat: 3, lon: 4, name: '2 New Home Rd', type: 'home' },
          type: 'home'
        },
        type: 'REMEMBER_LOCAL_USER_PLACE'
      })
      const home = state.localUser.savedLocations.find((l) => l.type === 'home')
      expect(home.address).toEqual('2 New Home Rd')
    })

    it('recents behavior is unchanged by the savedPlaces key', () => {
      const recent = {
        address: '300 Nicollet Mall',
        id: 'recent-abc',
        lat: 44.97,
        lon: -93.27,
        name: '300 Nicollet Mall',
        timestamp: 123,
        type: 'recent'
      }
      const state = reducer(
        freshState(),
        remember({ ...recent, type: 'recent' })
      )
      expect(state.localUser.recentPlaces).toHaveLength(1)
      expect(
        JSON.parse(window.localStorage.getItem('otp.recent'))
      ).toHaveLength(1)
      expect(storedCustoms()).toEqual([])
    })
  })

  describe('storeTripHistory default (persistence.trackRecentByDefault)', () => {
    afterEach(() => window.localStorage.clear())

    it('defaults off without the config flag', () => {
      expect(getUserInitialState({}).localUser.storeTripHistory).toBe(false)
    })

    it('defaults on when the config flag is set', () => {
      const state = getUserInitialState({
        persistence: { enabled: true, trackRecentByDefault: true }
      })
      expect(state.localUser.storeTripHistory).toBe(true)
    })

    it('an explicit user opt-out beats the config default', () => {
      window.localStorage.setItem('otp.trackRecent', 'false')
      const state = getUserInitialState({
        persistence: { enabled: true, trackRecentByDefault: true }
      })
      expect(state.localUser.storeTripHistory).toBe(false)
    })

    it('an explicit user opt-in works without the config flag', () => {
      window.localStorage.setItem('otp.trackRecent', 'true')
      expect(getUserInitialState({}).localUser.storeTripHistory).toBe(true)
    })
  })
})
