import { hidePlannerItineraryOverlay } from '../../../lib/components/map/connected-transitive-overlay'

/**
 * The stale-ghost gate (7/29 ride): GoModeMap wraps DefaultMap, which always
 * mounts the planner's transitive overlay, so the pre-trip search's paths
 * kept drawing under the live trip. The predicate hides the overlay on the
 * Go Mode screen only — while the trip is backgrounded the overlay is the
 * planner's own current search and must keep rendering.
 */
describe('components > go-mode > hidePlannerItineraryOverlay', () => {
  it('hides the planner overlay while Go Mode is foregrounded', () => {
    expect(
      hidePlannerItineraryOverlay({
        isActive: true,
        ui: { backgrounded: false }
      } as any)
    ).toBe(true)
  })

  it('keeps the overlay while browsing the planner mid-trip (backgrounded)', () => {
    expect(
      hidePlannerItineraryOverlay({
        isActive: true,
        ui: { backgrounded: true }
      } as any)
    ).toBe(false)
  })

  it('keeps the overlay when Go Mode is inactive', () => {
    expect(
      hidePlannerItineraryOverlay({
        isActive: false,
        ui: { backgrounded: false }
      } as any)
    ).toBe(false)
    expect(hidePlannerItineraryOverlay(undefined)).toBe(false)
    expect(hidePlannerItineraryOverlay(null)).toBe(false)
  })
})
