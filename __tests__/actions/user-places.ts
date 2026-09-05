import { rememberPlace } from '../../lib/actions/user'

const localStorageState = {
  otp: { config: { persistence: { enabled: true, strategy: 'localStorage' } } },
  user: { loggedInUser: null }
}

const dispatchAll = (placeTypeLocation: any) => {
  const dispatched: any[] = []
  const dispatch = (action: any) => {
    dispatched.push(action)
    return action
  }
  rememberPlace(placeTypeLocation, {} as any)(
    dispatch as any,
    () => localStorageState as any
  )
  return dispatched
}

const CUSTOM_HOME = {
  address: '2345 Old Shakopee Road West',
  icon: 'map-marker',
  id: 'place-oldshak',
  lat: 44.8168,
  lon: -93.3102,
  name: 'Home',
  type: 'custom'
}

describe('lib > actions > user > rememberPlace (localStorage)', () => {
  it('saving a custom place named "Home" fills the home slot', () => {
    const actions = dispatchAll({ location: CUSTOM_HOME, type: 'custom' })
    // The custom row is removed first, then the built-in slot is written.
    expect(actions.map((a) => a.type)).toEqual([
      'DELETE_LOCAL_USER_SAVED_PLACE',
      'REMEMBER_LOCAL_USER_PLACE'
    ])
    const remembered = actions[1].payload
    expect(remembered.type).toEqual('home')
    expect(remembered.location.type).toEqual('home')
    expect(remembered.location.icon).toEqual('home')
    // Legacy shape: name carries the address (what "otp.home" holds).
    expect(remembered.location.name).toEqual('2345 Old Shakopee Road West')
    expect(remembered.location.lat).toEqual(44.8168)
  })

  it('"  work  " fills the work slot with the briefcase icon', () => {
    const actions = dispatchAll({
      location: { ...CUSTOM_HOME, name: '  work  ' },
      type: 'custom'
    })
    const remembered = actions[actions.length - 1].payload
    expect(remembered.type).toEqual('work')
    // convertToLegacyLocation maps the briefcase icon to the legacy 'work'.
    expect(remembered.location.icon).toEqual('work')
  })

  it('a place with no id is not deleted first (new place)', () => {
    const { id: _id, ...noId } = CUSTOM_HOME
    const actions = dispatchAll({ location: noId, type: 'custom' })
    expect(actions.map((a) => a.type)).toEqual(['REMEMBER_LOCAL_USER_PLACE'])
  })

  it('other custom names are untouched', () => {
    const gym = { ...CUSTOM_HOME, name: 'Gym' }
    const actions = dispatchAll({ location: gym, type: 'custom' })
    expect(actions).toHaveLength(1)
    expect(actions[0].payload).toEqual({ location: gym, type: 'custom' })
  })

  it('a recent place named "home" stays a recent', () => {
    const recent = {
      ...CUSTOM_HOME,
      id: 'recent-x',
      name: 'home',
      type: 'recent'
    }
    const actions = dispatchAll({ location: recent, type: 'recent' })
    expect(actions).toHaveLength(1)
    expect(actions[0].payload.type).toEqual('recent')
  })

  it('an explicit home save is passed through unchanged', () => {
    const home = { lat: 1, lon: 2, name: '1 Home St', type: 'home' }
    const actions = dispatchAll({ location: home, type: 'home' })
    expect(actions).toHaveLength(1)
    expect(actions[0].payload).toEqual({ location: home, type: 'home' })
  })
})
