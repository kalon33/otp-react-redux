/**
 * position-source.ts — which producer emitted a fix.
 *
 * Go Mode has four things that can hand `handlePositionUpdate` a position: the
 * native background-geolocation watcher (one per arm — see `native-gps.ts`),
 * the browser polling path, the itinerary-derived simulation, and trip replay.
 * Until now they were indistinguishable once dispatched: `UPDATE_POSITION`
 * carried `{ coords, timestamp }` and nothing else, so the day file could not
 * say where a fix came from.
 *
 * That is what cost the 2026-09-17 evening ride its diagnosis (backlog 18.2).
 * Session `mu63yfrb-ekv1fl` delivered fixes that alternated between two tracks
 * 200–310 m apart, each advancing at bike speed, each with a fresh timestamp
 * and 9–22 m accuracy — and a whole evening of analysis could not settle
 * whether that was two watchers, one watcher with two sources underneath it,
 * or the browser poll running alongside the native stream. A tag on the fix
 * answers it by counting, on the next ride, with no new analysis.
 *
 * The tag is ADDITIVE and deliberately so: every consumer of a position reads
 * `coords` and `timestamp` by name, the fixture builder copies fields by name
 * (`replay/build-fixture.js`), and the reducer stores the payload whole. An
 * extra string key therefore reaches the day file and changes nothing else.
 */

/** A position carrying the producer that emitted it. */
export type TaggedPosition = GeolocationPosition & { source?: string }

/** `navigator.geolocation` polling — the non-native path. */
export const POSITION_SOURCE_BROWSER = 'browser'

/** The itinerary-derived GPS simulation (`startGpsSimulation`). */
export const POSITION_SOURCE_SIM = 'sim'

/** A recorded trip being replayed from a fixture. */
export const POSITION_SOURCE_REPLAY = 'replay'

/**
 * A plain-object copy of a browser `GeolocationPosition`, carrying `source`.
 *
 * Copied rather than annotated in place because a real `GeolocationPosition`
 * defines `toJSON()`, which wins over own properties in `JSON.stringify` — an
 * attached tag would be silently dropped on its way to the day file, which is
 * the one place it has to arrive. The seven `coords` fields are read by name
 * for the same reason: they live on the prototype, so a spread of `coords`
 * yields `{}` in WebKit.
 */
export function tagBrowserPosition(
  position: GeolocationPosition
): TaggedPosition {
  const c = position.coords
  return {
    coords: {
      accuracy: c.accuracy,
      altitude: c.altitude,
      altitudeAccuracy: c.altitudeAccuracy,
      heading: c.heading,
      latitude: c.latitude,
      longitude: c.longitude,
      speed: c.speed
    },
    source: POSITION_SOURCE_BROWSER,
    timestamp: position.timestamp
  } as TaggedPosition
}

/**
 * Coordinates MapLibre can place: latitude and longitude finite and inside
 * WGS84's range (backlog 75.1). One `{latitude: NaN, longitude: NaN}` fix
 * reached the Go Mode user-position `<Marker>`, MapLibre threw
 * `Invalid LngLat object: (NaN, NaN)` during render, and the whole app fell to
 * its error boundary mid-trip; a latitude past ±90 throws the same way.
 */
export function hasPlaceableCoords(
  position: GeolocationPosition | null | undefined
): position is GeolocationPosition {
  const c = position?.coords
  return (
    c != null &&
    Number.isFinite(c.latitude) &&
    Number.isFinite(c.longitude) &&
    Math.abs(c.latitude) <= 90 &&
    Math.abs(c.longitude) <= 180
  )
}

/**
 * A fix the pipeline can use (backlog 75.1): placeable coordinates and a
 * finite, non-negative accuracy. NaN compares false against every distance and
 * accuracy gate downstream, so a fix that fails this would pass them all as if
 * it were a good one. Every producer defaults a MISSING accuracy to a number
 * (`?? 10` in native-gps.ts and createMockPosition; the browser always reports
 * one), so this only ever turns away a value that is present and broken.
 */
export function isUsableFix(
  position: GeolocationPosition | null | undefined
): position is GeolocationPosition {
  if (!hasPlaceableCoords(position)) return false
  const { accuracy } = position.coords
  return Number.isFinite(accuracy) && accuracy >= 0
}
