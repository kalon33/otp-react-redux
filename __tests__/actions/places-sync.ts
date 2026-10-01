import { applyMiddleware, combineReducers, createStore } from 'redux'
import thunk from 'redux-thunk'

import {
  notePlacesWrite,
  PLACES_PUSH_DEBOUNCE_MS,
  resetPlacesSyncForTests,
  startPlacesSync
} from '../../lib/actions/places-sync'
import { recordedSessionEvents } from '../../lib/util/debug-log'
import createUserReducer from '../../lib/reducers/create-user-reducer'

jest.mock('../../lib/util/native-updates', () => ({
  getNativeDeviceId: jest.fn(() => Promise.resolve('NATIVE-UUID-1')),
  getRunningBundle: jest.fn(() =>
    Promise.resolve({ native: '0.0.36', version: '2026.0923.1' })
  )
}))
jest.mock('../../lib/util/debug-log-boot', () => ({
  getDeviceId: () => 'dev-web-id'
}))

const nativeUpdates = jest.requireMock('../../lib/util/native-updates')
const g = global as any

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

const config = { persistence: { enabled: true, strategy: 'localStorage' } }

/** A launch: a fresh store built from whatever localStorage holds now. */
function launch() {
  const store = createStore(
    combineReducers({
      otp: () => ({ config: {} }),
      user: createUserReducer(config)
    }),
    applyMiddleware(thunk)
  )
  // main.js's watcher, verbatim in effect.
  let lastSaved = store.getState().user.localUser.savedLocations
  let lastRecent = store.getState().user.localUser.recentPlaces
  store.subscribe(() => {
    const { recentPlaces, savedLocations } = store.getState().user.localUser
    if (savedLocations === lastSaved && recentPlaces === lastRecent) return
    const places = savedLocations !== lastSaved
    lastSaved = savedLocations
    lastRecent = recentPlaces
    store.dispatch(notePlacesWrite({ places }) as any)
  })
  return store
}

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const stored = (key: string) =>
  JSON.parse(window.localStorage.getItem(`otp.${key}`) || 'null')

const placesEvents = () =>
  recordedSessionEvents.filter((e: any) => e.event === 'PLACES_STATE')

/** fetch stub: GET answers `server`; POSTs are recorded (and update it). */
function serve(initial: any, { failGet = false, failPost = false } = {}) {
  const state = { posts: [] as any[], server: initial }
  g.fetch = jest.fn((url: string, init?: any) => {
    if (init?.method === 'POST') {
      if (failPost) return Promise.reject(new Error('offline'))
      const body = JSON.parse(init.body)
      state.posts.push({ body, url })
      state.server = body
      return Promise.resolve({ json: async () => ({ ok: true }), ok: true })
    }
    if (failGet) return Promise.reject(new Error('offline'))
    return Promise.resolve({ json: async () => state.server, ok: true })
  })
  return state
}

const remember = (location: any) => ({
  payload: { location, type: location.type },
  type: 'REMEMBER_LOCAL_USER_PLACE'
})

describe('lib > actions > places-sync (backlog 28.1)', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    resetPlacesSyncForTests()
    recordedSessionEvents.length = 0
    window.localStorage.clear()
  })
  afterEach(() => {
    jest.useRealTimers()
    g.fetch = undefined
  })

  it('beacons at boot with counts, key presence and the bundle — nothing else', async () => {
    window.localStorage.setItem('otp.savedPlaces', JSON.stringify([GYM, MOMS]))
    window.localStorage.setItem('otp.home', JSON.stringify(HOME))
    serve({ home: HOME, places: [GYM, MOMS], work: null })
    const store = launch()
    await store.dispatch(startPlacesSync() as any)
    const [boot] = placesEvents()
    expect(boot).toEqual({
      bundle: '2026.0923.1',
      dropped: 0,
      event: 'PLACES_STATE',
      home: true,
      idSource: 'native',
      keys: ['otp.savedPlaces', 'otp.home'],
      recent: 0,
      saved: 2,
      trigger: 'boot',
      work: false
    })
    expect(JSON.stringify(placesEvents())).not.toMatch(/Barbell|Gym|44\.9/)
  })

  it('beacons after every places write, recents included', async () => {
    serve({ home: null, places: [], work: null })
    const store = launch()
    await store.dispatch(startPlacesSync() as any)
    store.dispatch(remember(GYM))
    await flush()
    store.dispatch({ payload: GYM, type: 'DELETE_LOCAL_USER_SAVED_PLACE' })
    await flush()
    store.dispatch(
      remember({ lat: 44.1, lon: -93.1, name: 'Somewhere', type: 'recent' })
    )
    await flush()
    const writes = placesEvents().filter((e: any) => e.trigger === 'write')
    expect(writes.map((e: any) => [e.saved, e.recent])).toEqual([
      [1, 0],
      [0, 0],
      [0, 1]
    ])
  })

  it('replay: a cleared otp.savedPlaces comes back from the server', async () => {
    // Launch 1: the rider saves two places and Home; the copy goes up.
    const server = serve({ home: null, places: [], work: null })
    let store = launch()
    await store.dispatch(startPlacesSync() as any)
    store.dispatch(remember(GYM))
    store.dispatch(remember(MOMS))
    store.dispatch(remember(HOME))
    await flush()
    jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
    await flush()
    // One debounced POST covered the burst, keyed on the NATIVE id.
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0].url).toBe('/api/places')
    expect(server.posts[0].body.deviceId).toBe('NATIVE-UUID-1')
    expect(server.posts[0].body.places.map((p: any) => p.id)).toEqual([
      MOMS.id,
      GYM.id
    ])
    expect(server.posts[0].body.home).toMatchObject({ name: '1 Home St' })

    // Something clears the phone's storage — the web device id with it.
    window.localStorage.clear()
    resetPlacesSyncForTests()
    recordedSessionEvents.length = 0

    // Launch 2: boot shows the loss, the GET restores it.
    store = launch()
    expect(store.getState().user.localUser.savedLocations).toEqual([])
    await store.dispatch(startPlacesSync() as any)
    await flush()
    expect((g.fetch as jest.Mock).mock.calls[0][0]).toBe(
      '/api/places?deviceId=NATIVE-UUID-1'
    )
    expect(stored('savedPlaces').map((p: any) => p.id)).toEqual([
      MOMS.id,
      GYM.id
    ])
    expect(stored('home')).toMatchObject({ name: '1 Home St' })
    const ids = store
      .getState()
      .user.localUser.savedLocations.map((l: any) => l.id || l.type)
    expect(ids).toEqual(['home', MOMS.id, GYM.id])
    const events = placesEvents()
    expect(events.map((e: any) => [e.trigger, e.saved, e.home])).toEqual([
      ['boot', 0, false],
      ['restore', 2, true]
    ])
    expect(events[1].restored).toEqual({ home: true, places: 2, work: false })
    // The restore is not a rider write: no 'write' beacon, no POST.
    jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
    await flush()
    expect(server.posts).toHaveLength(1)
  })

  it('local wins: a non-empty list is not overwritten; a server-only place is added and pushed', async () => {
    const renamed = { ...GYM, name: 'Iron temple' }
    window.localStorage.setItem('otp.savedPlaces', JSON.stringify([renamed]))
    const server = serve({ home: null, places: [GYM, MOMS], work: null })
    const store = launch()
    await store.dispatch(startPlacesSync() as any)
    await flush()
    expect(stored('savedPlaces')).toEqual([renamed, MOMS])
    // The merged result went back up (the rename was not there yet).
    expect(server.posts).toHaveLength(1)
    expect(server.posts[0].body.places).toEqual([renamed, MOMS])
  })

  it('fails closed: a failed GET leaves local state alone and POSTs nothing', async () => {
    window.localStorage.setItem('otp.savedPlaces', JSON.stringify([GYM]))
    const server = serve(
      { home: HOME, places: [GYM, MOMS], work: null },
      { failGet: true }
    )
    const store = launch()
    const before = store.getState().user.localUser
    await store.dispatch(startPlacesSync() as any)
    await flush()
    expect(store.getState().user.localUser).toBe(before)
    expect(stored('savedPlaces')).toEqual([GYM])
    // A write while unreconciled retries the GET but never pushes blind.
    store.dispatch({ payload: GYM, type: 'DELETE_LOCAL_USER_SAVED_PLACE' })
    await flush()
    jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
    await flush()
    expect(server.posts).toHaveLength(0)
    expect(window.localStorage.getItem('otp.placesSyncPending')).toBeNull()
  })

  it('a failed POST keeps the write authoritative at the next launch (no resurrection)', async () => {
    const server = serve({ home: null, places: [GYM, MOMS], work: null })
    let store = launch()
    await store.dispatch(startPlacesSync() as any)
    await flush()
    jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
    await flush()
    expect(stored('savedPlaces')).toEqual([GYM, MOMS])
    // Delete Mom's while offline.
    g.fetch = jest.fn((url: string, init?: any) =>
      init?.method === 'POST'
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ json: async () => server.server, ok: true })
    )
    store.dispatch({ payload: MOMS, type: 'DELETE_LOCAL_USER_SAVED_PLACE' })
    await flush()
    jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
    await flush()
    expect(window.localStorage.getItem('otp.placesSyncPending')).toBe('true')

    // Next launch, back online: Mom's stays deleted and the delete goes up.
    resetPlacesSyncForTests()
    const next = serve(server.server)
    store = launch()
    await store.dispatch(startPlacesSync() as any)
    await flush()
    expect(stored('savedPlaces')).toEqual([GYM])
    expect(next.posts).toHaveLength(1)
    expect(next.posts[0].body.places).toEqual([GYM])
    expect(window.localStorage.getItem('otp.placesSyncPending')).toBeNull()
  })

  it('falls back to the web device id in a browser', async () => {
    nativeUpdates.getNativeDeviceId.mockImplementationOnce(() =>
      Promise.resolve(null)
    )
    serve({ home: null, places: [], work: null })
    const store = launch()
    await store.dispatch(startPlacesSync() as any)
    expect((g.fetch as jest.Mock).mock.calls[0][0]).toBe(
      '/api/places?deviceId=dev-web-id'
    )
    expect(placesEvents()[0].idSource).toBe('web')
  })
})
