import { patternToRouteFeature } from '@opentripplanner/transitive-overlay/lib/route-layers'
// @ts-expect-error getRouteLayerLayout is not typed in the package exports
import { getRouteLayerLayout } from '@opentripplanner/transitive-overlay/lib/route-layers'

/**
 * Rider report (2026 Q4): on an itinerary with two transit legs, the map
 * showed the route roundel for only ONE of them — the second line's label
 * was missing, both in the results preview and with the itinerary
 * selected.
 *
 * Root cause: the routes-labels layer places each route's roundel with
 * `symbol-placement: line-center` and, out of the box, `icon-allow-overlap:
 * false`. The two legs of a transfer meet near the same point, so their
 * roundels collide and maplibre's collision detector drops one — and
 * because `icon-optional: false` binds the label to the icon, the dropped
 * roundel takes its route name with it. The text side already allowed
 * overlap; the fork's transitive-overlay patch now lets the icons overlap
 * too (and ignore placement), so every leg keeps its label.
 */
describe('transitive-overlay route label layout (fork patch)', () => {
  it('lets colliding roundels keep their labels', () => {
    const layout = getRouteLayerLayout('name', ['Noto Sans Bold']) as Record<
      string,
      unknown
    >
    // The roundel must not be culled by the collision detector: with
    // icon-optional false, a culled icon removes the label too.
    expect(layout['icon-allow-overlap']).toBe(true)
    expect(layout['icon-ignore-placement']).toBe(true)
    // The label is still bound to its roundel.
    expect(layout['icon-optional']).toBe(false)
    // Placement and text behaviour unchanged by this patch.
    expect(layout['symbol-placement']).toBe('line-center')
    expect(layout['text-allow-overlap']).toBe(true)
  })

  it('still builds one labeled feature per transit route', () => {
    // Two non-degenerate stop geometries (distinct lat/lon pairs).
    const pattern: any = {
      pattern_id: 'ptn_0',
      route_id: 'r1',
      stops: [
        { stop_id: 's1', geometry: 'qkjcM}plfF' },
        { stop_id: 's2', geometry: 'sljcM}plfFDur~@' }
      ]
    }
    const routes: any[] = [
      {
        route_id: 'r1',
        route_short_name: '11',
        route_long_name: 'First Line',
        route_type: 3
      }
    ]
    const feature = patternToRouteFeature(pattern, routes)
    expect(feature.properties.name).toBe('11')
    expect(feature.properties.type).toBe('route')
    expect(feature.geometry.coordinates.length).toBeGreaterThan(1)
  })
})
