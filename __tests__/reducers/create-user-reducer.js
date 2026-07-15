import { getUserInitialState } from '../../lib/reducers/create-user-reducer'
import { restoreDateNowBehavior, setDefaultTestTime } from '../test-utils'

describe('lib > reducers > create-user-reducer', () => {
  afterEach(restoreDateNowBehavior)

  it('should be able to create the initial state', () => {
    setDefaultTestTime()
    expect(getUserInitialState({})).toMatchSnapshot()
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
