import { applyMiddleware, combineReducers, createStore } from 'redux'
import thunk from 'redux-thunk'

import {
  PLACES_PUSH_DEBOUNCE_MS,
  resetPlacesSyncForTests,
  startPlacesSync,
  watchPlacesWrites
} from '../../lib/actions/places-sync'
import { recordedSessionEvents } from '../../lib/util/debug-log'
import createUserReducer from '../../lib/reducers/create-user-reducer'

jest.mock('../../lib/util/native-updates', () => ({
  getNativeDeviceId: jest.fn(() => Promise.resolve('NATIVE-UUID-1')),
  getRunningBundle: jest.fn(() =>
    Promise.resolve({ native: '0.0.36', version: '2026.0923.1' })
  )
}))
jest.mock('../../lib/util/places-key', () => ({
  getPlacesKey: jest.fn(() => Promise.resolve(null))
}))
jest.mock('../../lib/util/debug-log-boot', () => ({
  getDeviceId: () => 'dev-web-id'
}))

const nativeUpdates = jest.requireMock('../../lib/util/native-updates')
const placesKey = jest.requireMock('../../lib/util/places-key')
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
function launch(userConfig: any = config) {
  const store = createStore(
    combineReducers({
      otp: () => ({ config: {} }),
      user: createUserReducer(userConfig)
    }),
    applyMiddleware(thunk)
  )
  // main.js's watcher — the same function.
  watchPlacesWrites(store)
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
function serve(
  initial: any,
  { failGet = false, failPost = false, oldServer = false } = {}
) {
  const state = { posts: [] as any[], server: initial }
  g.fetch = jest.fn((url: string, init?: any) => {
    if (init?.method === 'POST') {
      if (failPost) return Promise.reject(new Error('offline'))
      const body = JSON.parse(init.body)
      state.posts.push({ body, url })
      // A sidecar older than 58.2 keeps what it knows and drops the rest.
      const { routeSets, ...known } = body // eslint-disable-line @typescript-eslint/no-unused-vars
      state.server = oldServer ? known : body
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

  describe('saved route sets ride along (58.2, cycle 27 Q6 = B)', () => {
    const COMMUTE = {
      id: 'set-commute',
      name: 'Commute',
      routes: [
        { id: '1:18', label: '18' },
        { id: '1:21', label: '21' }
      ],
      savedAt: 1,
      scope: 'only'
    }
    const saveSet = (name: string, id: string) => ({
      payload: {
        draft: { name, routes: COMMUTE.routes, scope: 'only' },
        id,
        now: 1,
        replace: false
      },
      type: 'SAVE_ROUTE_SET'
    })

    it('saving a set is a places write: the POST carries the sets', async () => {
      const server = serve({
        home: null,
        places: [],
        routeSets: [],
        work: null
      })
      const store = launch()
      await store.dispatch(startPlacesSync() as any)
      store.dispatch(saveSet('Commute', 'set-commute'))
      await flush()
      jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
      await flush()
      expect(server.posts).toHaveLength(1)
      expect(server.posts[0].body.routeSets).toEqual([COMMUTE])
      expect(server.posts[0].body.deviceId).toBe('NATIVE-UUID-1')
    })

    it('a wiped phone gets its sets back from the server', async () => {
      const server = serve({
        home: null,
        places: [],
        routeSets: [COMMUTE],
        work: null
      })
      const store = launch()
      expect(store.getState().user.localUser.routeSets).toEqual([])
      await store.dispatch(startPlacesSync() as any)
      await flush()
      expect(stored('routeSets')).toEqual([COMMUTE])
      expect(store.getState().user.localUser.routeSets).toEqual([COMMUTE])
      const restore = placesEvents().find((e: any) => e.trigger === 'restore')
      expect(restore.restored).toEqual({
        home: false,
        places: 0,
        routeSets: 1,
        work: false
      })
      // The restore is not a rider write: nothing goes back up.
      jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
      await flush()
      expect(server.posts).toHaveLength(0)
    })

    it('an OLD server (no routeSets key) leaves the local sets alone, every launch', async () => {
      const server = serve(
        { home: null, places: [GYM], work: null },
        { oldServer: true }
      )
      window.localStorage.setItem('otp.savedPlaces', JSON.stringify([GYM]))
      window.localStorage.setItem('otp.routeSets', JSON.stringify([COMMUTE]))
      let store = launch()
      await store.dispatch(startPlacesSync() as any)
      await flush()
      jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
      await flush()
      expect(store.getState().user.localUser.routeSets).toEqual([COMMUTE])
      expect(stored('routeSets')).toEqual([COMMUTE])
      // In step on places, silent on sets: no POST at boot.
      expect(server.posts).toHaveLength(0)

      // The rider saves another set: the POST goes (the old server drops the
      // key), and the next launch still has both sets locally.
      store.dispatch(saveSet('Gym', 'set-gym'))
      await flush()
      jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
      await flush()
      expect(server.posts).toHaveLength(1)
      expect('routeSets' in server.server).toBe(false)

      resetPlacesSyncForTests()
      store = launch()
      await store.dispatch(startPlacesSync() as any)
      await flush()
      expect(
        store.getState().user.localUser.routeSets.map((s: any) => s.name)
      ).toEqual(['Gym', 'Commute'])
      expect(stored('savedPlaces').map((p: any) => p.id)).toEqual([GYM.id])
    })
  })
  describe('the installed app key + recents (60.1, cycle 31)', () => {
    const APP_KEY = 'Ab3_dEf-GhIjKlMnOpQrStUvWxYz0123456789abcde'
    // What the deployed config sets (frontend/port-config.yml): recents on.
    const tracking = {
      persistence: { ...config.persistence, trackRecentByDefault: true }
    }
    const recent = (n: number, timestamp: number) => ({
      icon: 'clock',
      id: `recent-${n}`,
      lat: 44.9 + n / 100,
      lon: -93.2,
      name: `${n} Recent Ave`,
      timestamp,
      type: 'recent'
    })
    const EMPTY = {
      home: null,
      places: [],
      recent: [],
      routeSets: [],
      work: null
    }

    /** fetch stub with one copy per deviceId, like places_api.py's files. */
    function serveById(initial: Record<string, any>, { failGetFor = '' } = {}) {
      const state = {
        copies: { ...initial } as Record<string, any>,
        gets: [] as string[],
        posts: [] as any[]
      }
      g.fetch = jest.fn((url: string, init?: any) => {
        if (init?.method === 'POST') {
          const body = JSON.parse(init.body)
          state.posts.push(body)
          state.copies[body.deviceId] = body
          return Promise.resolve({ json: async () => ({ ok: true }), ok: true })
        }
        const id = decodeURIComponent(url.split('deviceId=')[1])
        state.gets.push(id)
        if (id === failGetFor) return Promise.reject(new Error('offline'))
        return Promise.resolve({
          json: async () => state.copies[id] || { ...EMPTY, deviceId: id },
          ok: true
        })
      })
      return state
    }

    const settle = async () => {
      await flush()
      jest.advanceTimersByTime(PLACES_PUSH_DEBOUNCE_MS)
      await flush()
    }

    afterEach(() => {
      placesKey.getPlacesKey.mockImplementation(() => Promise.resolve(null))
      nativeUpdates.getNativeDeviceId.mockImplementation(() =>
        Promise.resolve('NATIVE-UUID-1')
      )
    })

    it('files the copy under the app key; the key never reaches a beacon', async () => {
      placesKey.getPlacesKey.mockImplementation(() => Promise.resolve(APP_KEY))
      const server = serveById({ [APP_KEY]: { ...EMPTY, home: HOME } })
      const store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      store.dispatch(remember(GYM))
      store.dispatch(remember(recent(1, 1000)))
      await settle()
      expect(server.gets).toEqual([APP_KEY])
      expect(server.posts).toHaveLength(1)
      expect(server.posts[0].deviceId).toBe(APP_KEY)
      const events = placesEvents()
      expect(events.map((e: any) => e.idSource)).toEqual(
        events.map(() => 'app-key')
      )
      // Not in any session record — PLACES_STATE or otherwise.
      expect(JSON.stringify(recordedSessionEvents)).not.toContain(APP_KEY)
      expect(JSON.stringify(recordedSessionEvents)).not.toContain(
        'NATIVE-UUID-1'
      )
    })

    it('reset: a new native id and an empty localStorage still find the copy via the key', async () => {
      placesKey.getPlacesKey.mockImplementation(() => Promise.resolve(APP_KEY))
      const server = serveById({})
      let store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      store.dispatch(remember(HOME))
      store.dispatch(remember(recent(1, 1000)))
      store.dispatch(remember(recent(2, 2000)))
      await settle()
      expect(server.copies[APP_KEY].recent.map((r: any) => r.id)).toEqual([
        'recent-2',
        'recent-1'
      ])

      // The 10-19 reset: container wiped, Capgo's Keychain id re-minted.
      window.localStorage.clear()
      resetPlacesSyncForTests()
      recordedSessionEvents.length = 0
      nativeUpdates.getNativeDeviceId.mockImplementation(() =>
        Promise.resolve('NATIVE-UUID-2')
      )
      store = launch(tracking)
      expect(store.getState().user.localUser.recentPlaces).toEqual([])
      await store.dispatch(startPlacesSync() as any)
      await settle()
      expect(server.gets.slice(-1)).toEqual([APP_KEY])
      expect(stored('home')).toMatchObject({ name: '1 Home St' })
      expect(stored('recent').map((r: any) => r.id)).toEqual([
        'recent-2',
        'recent-1'
      ])
      expect(
        store.getState().user.localUser.recentPlaces.map((r: any) => r.id)
      ).toEqual(['recent-2', 'recent-1'])
      const restore = placesEvents().find((e: any) => e.trigger === 'restore')
      expect(restore.restored).toEqual({
        home: true,
        places: 0,
        recent: 2,
        work: false
      })
      expect(restore.idSource).toBe('app-key')
    })

    it('migrates the old device-id copy to the key once, then never reads it again', async () => {
      placesKey.getPlacesKey.mockImplementation(() => Promise.resolve(APP_KEY))
      const legacy = {
        ...EMPTY,
        deviceId: 'NATIVE-UUID-1',
        home: HOME,
        places: [GYM],
        recent: [recent(1, 1000)]
      }
      const server = serveById({ 'NATIVE-UUID-1': legacy })
      let store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      await settle()
      expect(server.gets).toEqual([APP_KEY, 'NATIVE-UUID-1'])
      expect(stored('savedPlaces').map((p: any) => p.id)).toEqual([GYM.id])
      expect(stored('home')).toMatchObject({ name: '1 Home St' })
      expect(stored('recent').map((r: any) => r.id)).toEqual(['recent-1'])
      // Pushed under the key; the old copy is left exactly as it was.
      expect(server.posts.map((p: any) => p.deviceId)).toEqual([APP_KEY])
      expect(server.posts[0].places.map((p: any) => p.id)).toEqual([GYM.id])
      expect(server.posts[0].recent.map((r: any) => r.id)).toEqual(['recent-1'])
      expect(server.copies['NATIVE-UUID-1']).toBe(legacy)

      // Next launch: the key's copy holds something, so no legacy read.
      resetPlacesSyncForTests()
      server.gets.length = 0
      store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      await settle()
      expect(server.gets).toEqual([APP_KEY])
      expect(server.posts).toHaveLength(1)
    })

    it('a failed read of the old copy fails closed: nothing pushed under the key', async () => {
      placesKey.getPlacesKey.mockImplementation(() => Promise.resolve(APP_KEY))
      window.localStorage.setItem('otp.savedPlaces', JSON.stringify([MOMS]))
      const server = serveById(
        { 'NATIVE-UUID-1': { ...EMPTY, places: [GYM] } },
        { failGetFor: 'NATIVE-UUID-1' }
      )
      const store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      store.dispatch(remember(recent(1, 1000)))
      await settle()
      expect(server.posts).toHaveLength(0)
      expect(stored('savedPlaces').map((p: any) => p.id)).toEqual([MOMS.id])
    })

    it('without a key (older shell / browser) nothing changes: native id, no legacy read', async () => {
      const server = serveById({})
      const store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      await settle()
      expect(server.gets).toEqual(['NATIVE-UUID-1'])
      expect(placesEvents()[0].idSource).toBe('native')
    })

    it("one stray local recent (the reset app's first trip) does not block the restore", async () => {
      const onServer = [5, 4, 3, 2, 1].map((n) => recent(n, n * 1000))
      const stray = { ...recent(9, 9000), lat: 45.1, name: '9 Fresh St' }
      window.localStorage.setItem('otp.recent', JSON.stringify([stray]))
      const server = serveById({
        'NATIVE-UUID-1': { ...EMPTY, recent: onServer }
      })
      const store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      await settle()
      const ids = ['recent-9', 'recent-5', 'recent-4', 'recent-3', 'recent-2']
      expect(stored('recent').map((r: any) => r.id)).toEqual(ids)
      expect(
        store.getState().user.localUser.recentPlaces.map((r: any) => r.id)
      ).toEqual(ids)
      expect(server.posts).toHaveLength(1)
      expect(server.posts[0].recent.map((r: any) => r.id)).toEqual(ids)
      const restore = placesEvents().find((e: any) => e.trigger === 'restore')
      expect(restore.restored.recent).toBe(4)
    })

    it('an unacknowledged local write wins over the copy, recents included', async () => {
      window.localStorage.setItem('otp.recent', JSON.stringify([recent(1, 1)]))
      window.localStorage.setItem('otp.placesSyncPending', 'true')
      const server = serveById({
        'NATIVE-UUID-1': { ...EMPTY, recent: [recent(1, 1), recent(2, 2)] }
      })
      const store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      await settle()
      expect(stored('recent').map((r: any) => r.id)).toEqual(['recent-1'])
      expect(server.posts).toHaveLength(1)
      expect(server.posts[0].recent.map((r: any) => r.id)).toEqual(['recent-1'])
    })

    it('a recents-only write is pushed now', async () => {
      const server = serveById({})
      const store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      await settle()
      expect(server.posts).toHaveLength(0)
      store.dispatch(remember(recent(1, 1000)))
      await settle()
      expect(server.posts).toHaveLength(1)
      expect(server.posts[0].recent).toEqual([recent(1, 1000)])
      expect(window.localStorage.getItem('otp.placesSyncPending')).toBeNull()
    })

    it('a server reply without `recent` (older sidecar) leaves local recents alone and is not "behind"', async () => {
      window.localStorage.setItem('otp.recent', JSON.stringify([recent(1, 1)]))
      const server = serveById({
        'NATIVE-UUID-1': { home: null, places: [], routeSets: [], work: null }
      })
      const store = launch(tracking)
      await store.dispatch(startPlacesSync() as any)
      await settle()
      expect(stored('recent').map((r: any) => r.id)).toEqual(['recent-1'])
      expect(server.posts).toHaveLength(0)
    })

    it('a phone that does not track recents does not take them from the copy', async () => {
      const server = serveById({
        'NATIVE-UUID-1': { ...EMPTY, recent: [recent(1, 1)] }
      })
      const store = launch(config)
      await store.dispatch(startPlacesSync() as any)
      await settle()
      expect(stored('recent')).toBeNull()
      expect(store.getState().user.localUser.recentPlaces).toEqual([])
      expect(server.posts).toHaveLength(0)
    })
  })
})
