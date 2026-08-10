/**
 * Pure pieces of the onboard-discovery client (split from
 * onboard-discovery.js, whose `import.meta` Vite env read cannot be parsed
 * by jest — same arrangement as debug-log / debug-log-batch).
 */

// The OTP graph namespaces Metro Transit as feed "1"; the sidecar returns
// bare GTFS ids (e.g. "904").
export const OTP_FEED_PREFIX = '1:'

/**
 * Ordered, deduped candidate routes from the two sidecar answers — routes
 * with a live vehicle near the rider first (strongest evidence), then routes
 * whose shape passes under them — in the exact shape findRoutesNearby's
 * NEARBY_ROUTES_RESPONSE carries ({id, mode, shortName, longName}), so the
 * boarding prompt's manual route picker renders them identically.
 */
export function mergeCandidateRoutes(
  vehicles,
  routes,
  prefix = OTP_FEED_PREFIX
) {
  const ordered = []
  const seen = new Set()
  for (const list of [vehicles, routes]) {
    for (const entry of list || []) {
      const id = entry?.routeId
      if (id && !seen.has(id)) {
        seen.add(id)
        ordered.push({
          // The agency's own route colors, so the picker can show the badge a
          // rider actually recognises. A fleet number ("Bus #1731") identifies
          // nothing to someone standing on a curb.
          color: entry.color ?? null,
          id: `${prefix}${id}`,
          longName: entry.longName ?? null,
          mode: entry.mode ?? 'BUS',
          shortName: entry.shortName ?? null,
          textColor: entry.textColor ?? null
        })
      }
    }
  }
  return ordered
}

/**
 * vehicleId -> {direction, headsign} from the sidecar's vehicles-near answer.
 *
 * The boarding picker lists vehicles from OTP (grouped per route), which knows
 * nothing about which WAY each one is heading. The sidecar joins GTFS trips to
 * the live feed, so it can say "SB" — the single most useful word in that list
 * when the same route appears twice, once per direction.
 */
export function buildVehicleDetailMap(vehicles) {
  const map = {}
  for (const v of vehicles || []) {
    if (!v?.vehicleId) continue
    map[v.vehicleId] = {
      direction: v.direction ?? null,
      headsign: v.headsign ?? null
    }
  }
  return map
}
