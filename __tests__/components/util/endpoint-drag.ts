import { shouldIgnoreEndpointDrag } from '../../../lib/components/map/connected-endpoints-overlay'

// ~30m apart (Minneapolis latitude): a slip of the finger, not a decision.
const ANCHOR = { lat: 44.9276, lon: -93.2138 }
const NUDGE = { lat: 44.92772, lon: -93.21378 } // ~13m north
const BLOCK_AWAY = { lat: 44.9285, lon: -93.2138 } // ~100m north

const drag = (location: { lat: number; lon: number }) => ({
  location: { ...location, name: '44.92, -93.21' },
  locationType: 'to',
  reverseGeocode: true
})

describe('shouldIgnoreEndpointDrag', () => {
  it('never blocks non-drag setLocation calls (no reverseGeocode)', () => {
    expect(
      shouldIgnoreEndpointDrag(
        { location: NUDGE, locationType: 'to' },
        true,
        ANCHOR
      )
    ).toBe(false)
  })

  it('ignores any pin drag while a Go Mode trip is live', () => {
    // 7/13 ride: a drag 12s into the trip cleared the search and killed the
    // live trip. A live trip is never torn down by a map gesture.
    expect(shouldIgnoreEndpointDrag(drag(BLOCK_AWAY), true, ANCHOR)).toBe(true)
  })

  it('ignores a sub-threshold accidental drag', () => {
    expect(shouldIgnoreEndpointDrag(drag(NUDGE), false, ANCHOR)).toBe(true)
  })

  it('lets a deliberate drag through', () => {
    expect(shouldIgnoreEndpointDrag(drag(BLOCK_AWAY), false, ANCHOR)).toBe(
      false
    )
  })

  it('lets the drag through when there is no anchor to compare against', () => {
    expect(shouldIgnoreEndpointDrag(drag(NUDGE), false, null)).toBe(false)
    expect(shouldIgnoreEndpointDrag(drag(NUDGE), false, {})).toBe(false)
  })
})
