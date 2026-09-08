import { mapStateToProps } from '../../../lib/components/map/route-preview-overlay'

/**
 * 12.9. Session mtsvo7ss-4nzccy, 2026-09-08 11:55:54: "What's this other
 * highlight in the trip? are we still showing alternate routes?"
 *
 * The pale line under the live 546 was RoutePreviewOverlay — it draws EVERY
 * leg of EVERY itinerary in the active search as a blurred dashed grey line,
 * and unlike the transitive overlay it had no Go Mode gate, so the planner
 * search the rider ran at 11:26 kept painting under the live trip for the next
 * 29 minutes. It is on precisely when nothing is selected, and a fresh
 * ROUTING_REQUEST resets the new search's `activeItinerary` to null — which is
 * why the rider's own SET_ACTIVE_ITINERARY {index: 0} at 11:26:08 did not hold
 * it off, and why re-planning the same searchId at 11:30:15 and 11:55:58
 * (refreshStaleSearch) turned it back on.
 */
const geometry = { points: 'a~l~Fjk~uOwHJy@P' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = (goMode: any): any => ({
  otp: {
    activeSearchId: 'bmf8dmidt',
    config: {
      // The deployed value (app-config.yml): this is what ENABLES the layer.
      itinerary: { showFirstResultByDefault: false }
    },
    currentQuery: {
      from: { lat: 44.9, lon: -93.2 },
      to: { lat: 44.8, lon: -93.3 }
    },
    goMode,
    searches: {
      bmf8dmidt: {
        // What a fresh ROUTING_REQUEST leaves behind.
        activeItinerary: null,
        query: {
          from: { lat: 44.9, lon: -93.2 },
          to: { lat: 44.8, lon: -93.3 }
        },
        response: [
          {
            plan: {
              itineraries: [
                { legs: [{ legGeometry: geometry }] },
                { legs: [{ legGeometry: geometry }] }
              ]
            }
          }
        ],
        visibleItinerary: undefined
      }
    },
    ui: { mainPanelContent: null }
  }
})

describe('components > map > RoutePreviewOverlay, Go Mode gate', () => {
  it('does not paint the planner search under a live trip in the foreground', () => {
    // FAILS BEFORE: returned two dashed geometries with visible: true.
    const props = mapStateToProps(
      state({ isActive: true, ui: { backgrounded: false } })
    )
    expect(props).toEqual({})
  })

  it('still paints it while the rider is out in the planner', () => {
    // The search must survive the trip: step back out and the options — and
    // "Switch to this trip" — are all still there.
    const props = mapStateToProps(
      state({ isActive: true, ui: { backgrounded: true } })
    )
    expect(props.visible).toBe(true)
    expect(props.geometries).toHaveLength(2)
  })

  it('is untouched when no trip is running', () => {
    const props = mapStateToProps(state({ isActive: false, ui: {} }))
    expect(props.visible).toBe(true)
    expect(props.geometries).toHaveLength(2)
  })

  it('reproduces the state that made it visible: nothing selected', () => {
    // Both selectors null is the whole trigger, and it is the state a fresh
    // search lands in — not something the rider has to do.
    const props = mapStateToProps(state({ isActive: false, ui: {} }))
    expect(props.visible).toBe(true)
  })
})
