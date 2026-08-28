/**
 * Pure pieces of the onboard-discovery client (split from
 * onboard-discovery.js, whose `import.meta` Vite env read cannot be parsed
 * by jest — same arrangement as debug-log / debug-log-batch).
 */

/**
 * Ordered, deduped candidate routes from the two sidecar answers — routes
 * with a live vehicle near the rider first (strongest evidence), then routes
 * whose shape passes under them — in the exact shape findRoutesNearby's
 * NEARBY_ROUTES_RESPONSE carries ({id, mode, shortName, longName}), so the
 * boarding prompt's manual route picker renders them identically.
 *
 * The id arrives ALREADY feed-qualified ("2:465") because the request asks for
 * `feeds=all`; this function never builds one. It used to prepend a hardcoded
 * "1:", which silently erased every agency but Metro Transit — MVTA's 465 came
 * back as "1:465", an id no route in the graph has, so the rider's own
 * commuter bus could not be discovered. Only the sidecar read the GTFS zips
 * and can say which feed a route came from; guessing here is what broke it.
 */
export function mergeCandidateRoutes(vehicles, routes) {
  const ordered = []
  const seen = new Set()
  for (const list of [vehicles, routes]) {
    for (const entry of list || []) {
      // A bare id means an older sidecar that predates feed scoping. Skip it
      // rather than invent a prefix: a wrong feed resolves to nothing and
      // leaves the picker empty, which is worse than one missing candidate.
      const id = entry?.id
      if (id && id.includes(':') && !seen.has(id)) {
        seen.add(id)
        ordered.push({
          // The agency's own route colors, so the picker can show the badge a
          // rider actually recognises. A fleet number ("Bus #1731") identifies
          // nothing to someone standing on a curb.
          color: entry.color ?? null,
          id,
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
