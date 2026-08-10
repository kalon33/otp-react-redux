/**
 * Onboard-discovery client for the "I'm already on the bus" flow: asks the
 * transitnav sidecar what the rider is ON — live vehicles near their GPS
 * position first (the nearest bus IS the answer, trip and route included),
 * route shapes under the point second (fallback when realtime lags). Stop
 * proximity is NOT consulted here: a rider mid-route (freeway BRT between
 * stations) is on a route's map line but near no stop — the 2026-07-12 ride
 * got "no buses found" three times exactly this way.
 *
 * Fail-open: any network/endpoint failure resolves to null and the caller
 * falls back to the legacy stop-radius discovery.
 */

// Web builds leave VITE_API_BASE_URL unset (same-origin; vite dev proxies
// /api/onboard to the local sidecar, nginx proxies it in prod). The bundled
// native app sets the base to the server's absolute URL (see debug-log.js).
import {
  buildVehicleDetailMap,
  mergeCandidateRoutes
} from './onboard-discovery-util'

const API_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) ||
  ''

async function getJson(path, timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Candidate routes ({id, mode, shortName, longName}) for what the rider is
 * riding at (lat, lon), or null when the sidecar is unreachable (caller
 * falls back to stop-radius discovery). vehicleRadiusM should already be
 * speed-adjusted — GTFS-RT positions lag a moving bus.
 */
/**
 * Both halves of the sidecar's answer from ONE pair of requests:
 *   routes          - candidate routes, as above
 *   vehicleDetails  - vehicleId -> {direction, headsign}
 *
 * The boarding picker needs the second half because it lists vehicles from
 * OTP, which knows the run but not which way it points. Fetching them together
 * keeps that to a single round trip on a bus with one bar of signal.
 */
export async function fetchOnboardContext(lat, lon, vehicleRadiusM) {
  const point = `lat=${lat}&lon=${lon}`
  const [vehicles, routes] = await Promise.all([
    getJson(
      `/api/onboard/vehicles-near?${point}&radius=${Math.round(vehicleRadiusM)}`
    ),
    getJson(`/api/onboard/routes-at-point?${point}&radius=100`)
  ])
  if (!vehicles && !routes) return null
  return {
    routes: mergeCandidateRoutes(vehicles?.vehicles, routes?.routes),
    vehicleDetails: buildVehicleDetailMap(vehicles?.vehicles)
  }
}

export async function fetchOnboardCandidateRoutes(lat, lon, vehicleRadiusM) {
  return (await fetchOnboardContext(lat, lon, vehicleRadiusM))?.routes ?? null
}
