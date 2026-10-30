import { applyMiddleware, combineReducers, createStore } from 'redux'
import thunk from 'redux-thunk'

import { createQueryAction } from '../../lib/actions/api'
import { rememberPlace } from '../../lib/actions/user'
import { resetSafeStorageForTests } from '../../lib/util/safe-storage'
import createUserReducer from '../../lib/reducers/create-user-reducer'

/**
 * Backlog 75.12 (a), from the 2026-10-29 chaos run (C14,
 * `chaos/s6-storage.js quota`): with localStorage full, search `eppe018ox`
 * went ROUTING_REQUEST 00:30:39.619 → ROUTING_ERROR {index 1, error {}}
 * 00:30:40.176 although OTP had answered.
 *
 * The plan callback (apiV2.js, routingQuery's per-combo callback) dispatches
 * `rememberPlace(...)` for the recents BEFORE returning `routingResponse`.
 * REMEMBER_LOCAL_USER_PLACE wrote `otp.recent` from inside the user REDUCER
 * (`rememberLocalUserPlace` → `storeItem`), the QuotaExceededError escaped the
 * reducer, the dispatch, and the callback, and createQueryAction's catch turned
 * an answered search into `errorAction(err)`.
 *
 * Driven through createQueryAction's replay lane, which runs the same
 * responseAction-in-a-try as the network lane (api.js), with a callback that
 * does what apiV2's does: remember, then return the response.
 */

const PERSISTENCE = { enabled: true, strategy: 'localStorage' }
const CONFIG = {
  api: { host: 'http://mock-host.com', path: '/otp', port: 80 },
  persistence: PERSISTENCE
}
const DOWNTOWN = {
  id: 'recent-downtown',
  lat: 44.9778,
  lon: -93.2707,
  name: 'Downtown Minneapolis',
  timestamp: 1793245839619,
  type: 'recent'
}

const quotaExceeded = () => {
  throw new DOMException(
    "Failed to execute 'setItem' on 'Storage': Setting the value of 'otp.recent' exceeded the quota.",
    'QuotaExceededError'
  )
}

function makeStore() {
  const types: string[] = []
  const store = createStore(
    combineReducers({
      log: (state = null, action: { type: string }) => {
        types.push(action.type)
        return state
      },
      otp: (state = { config: CONFIG }) => state,
      user: createUserReducer({ persistence: PERSISTENCE })
    }),
    applyMiddleware(thunk)
  )
  return { store, types }
}

describe('75.12 (a) a full localStorage does not turn an answered search into ROUTING_ERROR', () => {
  let setItem: jest.SpyInstance

  beforeEach(() => {
    window.localStorage.clear()
    setItem = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(quotaExceeded)
  })

  afterEach(() => {
    setItem.mockRestore()
    window.localStorage.clear()
    resetSafeStorageForTests()
  })

  it('the plan answer is a ROUTING_RESPONSE even though the recents write failed', async () => {
    const { store, types } = makeStore()
    await store.dispatch(
      createQueryAction(
        'plan',
        (payload: unknown) => {
          // apiV2's callback: recents first, then the response action.
          store.dispatch(
            rememberPlace({ location: DOWNTOWN, type: 'recent' }) as any
          )
          return { payload, type: 'ROUTING_RESPONSE' }
        },
        (error: unknown) => ({ payload: { error }, type: 'ROUTING_ERROR' }),
        { noThrottle: true, replayRawResponse: { plan: { itineraries: [] } } }
      ) as any
    )
    // The write really was attempted (and refused) — this is not a test that
    // passes because nothing touched storage.
    expect(setItem).toHaveBeenCalledWith('otp.recent', expect.any(String))
    expect(types).toContain('ROUTING_RESPONSE')
    expect(types).not.toContain('ROUTING_ERROR')
  })

  it('the dispatch does not throw, and the recent place still reaches the store', () => {
    const { store } = makeStore()
    expect(() =>
      store.dispatch(
        rememberPlace({ location: DOWNTOWN, type: 'recent' }) as any
      )
    ).not.toThrow()
    expect(store.getState().user.localUser.recentPlaces[0]).toMatchObject({
      lat: DOWNTOWN.lat,
      lon: DOWNTOWN.lon
    })
  })
})
