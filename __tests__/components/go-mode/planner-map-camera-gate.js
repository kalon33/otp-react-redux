// jsdom does not implement matchMedia, and the app's styled-components read it
// at import time (components/util/prefersReducedMotion). Stub it, then require
// the module — a static import would be hoisted above the stub.
window.matchMedia = window.matchMedia || (() => ({ matches: false }))
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  goModeOwnsMapCamera,
  ResponsiveWebapp
} = require('../../../lib/components/app/responsive-webapp')

/**
 * 2026-09-04 ride, 11:06:03 — "I can no longer move around on the screen. It's
 * locked to my gos point. And the arrow button doesn't seem to work."
 *
 * There is one map instance: GoModeMap wraps the same DefaultMap the planner
 * uses. ResponsiveWebapp.componentDidUpdate auto-centers that map on
 * `query.from` whenever the planner has no active itinerary — and a RESUMED Go
 * Mode trip is exactly that state (the resume clears the search, then
 * getCurrentPosition seeds `from` with Current Location and leaves `to` unset).
 * `goMode` is in this component's mapStateToProps, so it re-rendered on every
 * position/progress tick and re-panned the camera to the rider several times a
 * second. Nothing about `goMode.ui.mapFollowUser` was involved, which is why
 * the follow toggle looked dead.
 */

// The exact props of the resumed 2026-09-04 trip, minus what each case varies.
const rideProps = (overrides) => ({
  activeItinerary: null, // CLEAR_ACTIVE_SEARCH on resume
  activeSearchId: null,
  autoFly: undefined, // autoFlyOnTripFormUpdate is commented out in app-config
  currentPosition: { coords: { latitude: 44.8168, longitude: -93.3102 } },
  formChanged: jest.fn(),
  goMode: { isActive: true, ui: { backgrounded: false } },
  intl: {},
  location: { pathname: '/', search: '' },
  mainPanelContent: null,
  map: {},
  matchContentToUrl: jest.fn(),
  query: { from: { lat: 44.8168, lon: -93.3102 }, to: null },
  setLocationToCurrent: jest.fn(),
  setMapCenter: jest.fn(),
  ...overrides
})

function runDidUpdate(props) {
  // Same currentPosition object in prev and next props, so the "device
  // position changed" branch is skipped and the auto-fly branch is the one
  // under test — which is what every Go Mode tick looks like.
  const prevProps = { ...props, query: { ...props.query } }
  ResponsiveWebapp.prototype.componentDidUpdate.call({ props }, prevProps)
  return props
}

describe('components > go-mode > planner map camera gate', () => {
  it('does not re-center the map on the rider while Go Mode is foregrounded', () => {
    const props = runDidUpdate(rideProps())
    expect(props.setMapCenter).not.toHaveBeenCalled()
  })

  it('still re-centers for the planner when no trip is running', () => {
    const props = runDidUpdate(rideProps({ goMode: null }))
    expect(props.setMapCenter).toHaveBeenCalledTimes(1)
    expect(props.setMapCenter).toHaveBeenCalledWith(props.map, props.query.from)
  })

  it('still re-centers while the trip is backgrounded (planner on screen)', () => {
    const props = runDidUpdate(
      rideProps({ goMode: { isActive: true, ui: { backgrounded: true } } })
    )
    expect(props.setMapCenter).toHaveBeenCalledTimes(1)
  })

  describe('goModeOwnsMapCamera', () => {
    it('is true only for a foregrounded live trip', () => {
      expect(
        goModeOwnsMapCamera({ isActive: true, ui: { backgrounded: false } })
      ).toBe(true)
      expect(
        goModeOwnsMapCamera({ isActive: true, ui: { backgrounded: true } })
      ).toBe(false)
      expect(
        goModeOwnsMapCamera({ isActive: false, ui: { backgrounded: false } })
      ).toBe(false)
      expect(goModeOwnsMapCamera(undefined)).toBe(false)
      expect(goModeOwnsMapCamera(null)).toBe(false)
    })
  })
})
