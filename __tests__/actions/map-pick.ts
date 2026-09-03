import '../test-utils/mock-window-url'
import { cancelMapPick, startMapPick } from '../../lib/actions/ui'
import { MobileScreens } from '../../lib/actions/ui-constants'

/**
 * Rider ask, backlog 3.9. On a phone the location picker is a whole screen
 * (mobile/location-search), so "Choose on map" has to both arm the mode and
 * leave that screen — otherwise the rider is left staring at the picker with
 * no map to tap.
 */
describe('actions > ui > map pick mode', () => {
  function run(mobileScreen: number) {
    const dispatched: any[] = []
    const dispatch = (action: any) => dispatched.push(action)
    const getState = () => ({ otp: { ui: { mobileScreen } } })
    startMapPick('from')(dispatch, getState)
    return dispatched
  }

  it('arms pick mode for the field that asked', () => {
    expect(run(MobileScreens.SEARCH_FORM)[0]).toEqual({
      payload: { locationType: 'from' },
      type: 'SET_MAP_PICK_MODE'
    })
  })

  it('closes the full-screen picker on the way to the map', () => {
    const pickerScreens = [
      MobileScreens.SET_FROM_LOCATION,
      MobileScreens.SET_TO_LOCATION,
      MobileScreens.SET_INITIAL_LOCATION
    ]
    pickerScreens.forEach((screen) => {
      expect(run(screen)).toContainEqual({
        payload: MobileScreens.SEARCH_FORM,
        type: 'SET_MOBILE_SCREEN'
      })
    })
  })

  it('leaves the screen alone when the field is already inline', () => {
    const inlineScreens = [
      MobileScreens.SEARCH_FORM,
      MobileScreens.RESULTS_SUMMARY
    ]
    inlineScreens.forEach((screen) => {
      expect(
        run(screen).filter((a) => a.type === 'SET_MOBILE_SCREEN')
      ).toHaveLength(0)
    })
  })

  it('disarms with a null location type', () => {
    expect(cancelMapPick()).toEqual({
      payload: { locationType: null },
      type: 'SET_MAP_PICK_MODE'
    })
  })
})
