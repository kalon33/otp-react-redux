/**
 * Check-in with the two German journey-logging services, Träwelling
 * (https://traewelling.de/api/documentation) and travelynx
 * (https://travelynx.de/api), from the legs of an OTP itinerary.
 *
 * The two services are addressed in parallel and independently: either, both
 * or neither can be configured in Settings, and each keeps its own token on
 * the device (util/checkin-settings).
 *
 * Träwelling has no "check in by name" endpoint — its current documented
 * flow (https://traewelling.de/docs?api-docs.json) is station autocomplete →
 * departures → trip → checkin, against its MOTIS backend. So a leg is resolved
 * first: the boarding stop's station id comes from the autocomplete, the
 * departures board is searched for the leg's line around the leg's
 * departure, the matching departure's trip is fetched, and the two stopovers
 * that match the leg's from/to stops become the checkin's origin and
 * destination, with the trip's own planned times.
 *
 * travelynx accepts a checkin by train type/number and station names in one
 * call (`POST /api/v1/travel`). Names must match what its backend knows, so
 * the same resolution caveat applies, but there is nothing to look up first.
 * Its API sends no CORS headers, so from a browser the check-in is sent as a
 * simple `no-cors` request whose answer cannot be read (see travelynxCheckin).
 *
 * Both requests carry the rider's token, so they never go through the OTP
 * backend; they are sent straight to the service from the browser.
 */

export type CheckinService = 'trawelling' | 'travelynx'

export interface ServiceSettings {
  /** API base; overrides the production default for self-hosted instances. */
  baseUrl?: string
  /** Whether the rider wants this service linked; enables its UI everywhere. */
  enabled: boolean
  /** The service's API token, set from its settings page. */
  token: string
}

export interface CheckinSettings {
  travelynx: ServiceSettings
  trawelling: ServiceSettings
}

/** The result of one checkin, per service. */
export interface CheckinResult {
  /** The service's own error text, shown to the rider as-is. */
  error?: string
  ok: boolean
  /** True when the check-in was sent but its answer could not be read. */
  sent?: boolean
  /** The id of the created status/journey, when the service returns one. */
  statusId?: string
}

export const DEFAULT_TRAEWELLING_BASE = 'https://traewelling.de/api'
export const DEFAULT_TRAVELYNX_BASE = 'https://travelynx.de'

/** Tolerance when matching a planned departure against the leg's departure. */
const DEPARTURE_MATCH_TOLERANCE_MS = 20 * 60 * 1000

const TRANSIT_MODES = [
  'BUS',
  'FERRY',
  'FUNICULAR',
  'GONDOLA',
  'RAIL',
  'SUBWAY',
  'TRAM'
]

export function isTransitLeg(leg: {
  mode?: string
  transitLeg?: boolean
}): boolean {
  return !!leg.transitLeg || TRANSIT_MODES.includes(leg.mode ?? '')
}

/** travelynx names train types its own way; map OTP's modes onto them. */
function travelynxTrainType(mode: string): string {
  switch (mode) {
    case 'RAIL':
      return 'RE'
    case 'SUBWAY':
      return 'U'
    case 'TRAM':
      return 'STR'
    default:
      return mode
  }
}

/** The line name a checkin service expects, e.g. "S 6" or "ICE 471". */
function lineName(leg: LegForCheckin): string {
  const short = leg.routeShortName || (leg.route as any)?.shortName
  const long = leg.routeLongName || (leg.route as any)?.longName
  return String(short || long || '')
}

/** The shape of an OTP itinerary leg the checkin layer reads. */
export interface LegForCheckin {
  endTime?: number | string
  from: { name?: string }
  mode?: string
  route?: string | { longName?: string; shortName?: string }
  routeLongName?: string
  routeShortName?: string
  startTime?: number | string
  to: { name?: string }
}

function startTimeMs(leg: LegForCheckin): number {
  const t = leg.startTime
  return typeof t === 'string' ? Date.parse(t) : t ?? Date.now()
}

async function readJson(
  url: string,
  init?: RequestInit
): Promise<{ json: any; ok: boolean; status: number }> {
  const response = await fetch(url, init)
  let json: any = null
  try {
    json = await response.json()
  } catch {
    // A non-JSON body is reported through the status below.
  }
  return { json, ok: response.ok, status: response.status }
}

function bearer(token: string): {
  Authorization: string
  'Content-Type': string
} {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
}

function trawellingError(json: any, status: number): string {
  return (
    json?.message ||
    json?.error ||
    json?.errors?.[0]?.message ||
    `Träwelling API error (HTTP ${status})`
  )
}

/**
 * Resolve a stop name to Träwelling's station id with its autocomplete
 * endpoint. Slashes are forbidden in the path segment, so they become spaces
 * (the documented workaround).
 */
async function trawellingStationId(
  base: string,
  token: string,
  name: string
): Promise<number | null> {
  const query = encodeURIComponent(name).replace(/%2F/gi, '%20')
  const response = await readJson(
    `${base}/v1/trains/station/autocomplete/${query}`,
    { headers: bearer(token) }
  )
  if (!response.ok) return null
  const id = response.json?.data?.[0]?.id
  return typeof id === 'number' ? id : null
}

/**
 * Check a leg into Träwelling, following the current v1 flow documented at
 * https://traewelling.de/docs?api-docs.json: station autocomplete →
 * departures → trip → checkin, against its MOTIS backend. The checkin body
 * needs the trip's INTERNAL trip id, the two STATION ids and the exact
 * planned stopover times — all taken from the trip resource, so the server's
 * stopover lookup (`train_station_id` + `departure_planned`/`arrival_planned`)
 * matches.
 */
export async function trawellingCheckin(
  settings: ServiceSettings,
  leg: LegForCheckin
): Promise<CheckinResult> {
  const base = (settings.baseUrl || DEFAULT_TRAEWELLING_BASE).replace(
    /\/+$/,
    ''
  )
  const line = lineName(leg)
  const fromName = leg.from?.name
  const toName = leg.to?.name
  const start = startTimeMs(leg)
  if (!fromName || !toName) {
    return { error: 'The leg has no stop names to check in with.', ok: false }
  }

  // 1. The boarding stop's station id.
  let fromStationId: number | null = null
  try {
    fromStationId = await trawellingStationId(base, settings.token, fromName)
  } catch {
    // The lookup below reports the failure.
  }
  if (fromStationId == null) {
    return {
      error: `Träwelling does not know a station "${fromName}".`,
      ok: false
    }
  }

  // 2. The departures board of that station, around the leg's departure.
  const departuresUrl =
    `${base}/v1/station/${fromStationId}/departures` +
    `?when=${encodeURIComponent(new Date(start).toISOString())}`
  const departures = await readJson(departuresUrl, {
    headers: bearer(settings.token)
  })
  if (!departures.ok) {
    return {
      error: trawellingError(departures.json, departures.status),
      ok: false
    }
  }
  const candidates: any[] = departures.json?.data ?? []
  const departure = candidates.find((d: any) => {
    if (!d?.tripId || d?.cancelled) return false
    if (line && String(d?.line?.name ?? d?.line?.id ?? '') !== line)
      return false
    const when = Date.parse(d.when ?? d.plannedWhen ?? '')
    if (Number.isNaN(when)) return false
    return Math.abs(when - start) <= DEPARTURE_MATCH_TOLERANCE_MS
  })
  if (!departure) {
    return {
      error: `No ${
        line || 'transit'
      } departure from ${fromName} matches this leg.`,
      ok: false
    }
  }
  const departureLineName = String(
    departure.line?.name ?? departure.line?.id ?? line
  )

  // 3. The trip behind that departure, for its internal id and stopovers.
  const tripUrl =
    `${base}/v1/trains/trip` +
    `?hafasTripId=${encodeURIComponent(departure.tripId)}` +
    `&lineName=${encodeURIComponent(departureLineName)}`
  const trip = await readJson(tripUrl, { headers: bearer(settings.token) })
  if (!trip.ok) {
    return { error: trawellingError(trip.json, trip.status), ok: false }
  }
  const tripData = trip.json?.data
  const stopovers: any[] = tripData?.stopovers ?? []
  const startIndex = stopovers.findIndex(
    (s: any) =>
      s?.station?.id === fromStationId || s?.station?.name === fromName
  )
  const destIndex = stopovers.findIndex(
    (s: any, i: number) => i > startIndex && s?.station?.name === toName
  )
  if (startIndex < 0 || destIndex < 0) {
    return {
      error: `${fromName} → ${toName} is not part of the ${
        line || 'trip'
      } journey found.`,
      ok: false
    }
  }
  const startStopover = stopovers[startIndex]
  const destStopover = stopovers[destIndex]
  if (!startStopover.departurePlanned || !destStopover.arrivalPlanned) {
    return {
      error: `The ${
        line || 'trip'
      } journey found has no times for ${fromName} → ${toName}.`,
      ok: false
    }
  }

  // 4. The checkin itself: internal trip id, the two station ids, and the
  // trip's own planned stopover times, verbatim.
  const checkin = await readJson(`${base}/v1/trains/checkin`, {
    body: JSON.stringify({
      arrival: destStopover.arrivalPlanned,
      departure: startStopover.departurePlanned,
      destination: destStopover.station.id,
      lineName: String(tripData?.lineName ?? departureLineName),
      start: startStopover.station.id,
      tripId: tripData?.tripId
    }),
    headers: bearer(settings.token),
    method: 'POST'
  })
  if (!checkin.ok) {
    return { error: trawellingError(checkin.json, checkin.status), ok: false }
  }
  const statusId = checkin.json?.data?.status?.id ?? checkin.json?.data?.id
  return { ok: true, statusId: statusId != null ? String(statusId) : undefined }
}

/**
 * Check a leg into travelynx with a single POST /api/v1/travel call.
 *
 * travelynx's API sends no CORS headers, so a browser cannot read the answer
 * — often the request itself is refused when the JSON content type triggers
 * a preflight. When that happens, the check-in is re-sent as a simple
 * `no-cors` request: travelynx executes it, but the result comes back opaque,
 * which the caller reports as "sent" rather than "checked in".
 */
export async function travelynxCheckin(
  settings: ServiceSettings,
  leg: LegForCheckin
): Promise<CheckinResult> {
  const base = (settings.baseUrl || DEFAULT_TRAVELYNX_BASE).replace(/\/+$/, '')
  const line = lineName(leg)
  const fromName = leg.from?.name
  const toName = leg.to?.name
  if (!fromName || !toName) {
    return { error: 'The leg has no stop names to check in with.', ok: false }
  }
  const body = JSON.stringify({
    action: 'checkin',
    fromStation: fromName,
    token: settings.token,
    toStation: toName,
    train: {
      no: line || undefined,
      type: travelynxTrainType(leg.mode ?? 'BUS')
    }
  })
  try {
    const response = await readJson(`${base}/api/v1/travel`, {
      body,
      headers: { 'Content-Type': 'application/json' },
      method: 'POST'
    })
    const json = response.json
    if (!json?.success) {
      return {
        error: json?.error || `travelynx API error (HTTP ${response.status})`,
        ok: false
      }
    }
    return { ok: true }
  } catch {
    // A refused preflight never reached travelynx; a simple request does.
    try {
      await fetch(`${base}/api/v1/travel`, {
        body,
        headers: { 'Content-Type': 'text/plain' },
        method: 'POST',
        mode: 'no-cors'
      })
      return { ok: true, sent: true }
    } catch {
      return {
        error:
          'travelynx is unreachable from the browser (its API sends no CORS headers).',
        ok: false
      }
    }
  }
}

/** Check one leg into every enabled service, in parallel. */
export async function checkinLeg(
  settings: CheckinSettings,
  leg: LegForCheckin
): Promise<Partial<Record<CheckinService, CheckinResult>>> {
  const jobs: Promise<[CheckinService, CheckinResult]>[] = []
  if (settings.trawelling.enabled && settings.trawelling.token) {
    jobs.push(
      trawellingCheckin(settings.trawelling, leg).then((r) => ['trawelling', r])
    )
  }
  if (settings.travelynx.enabled && settings.travelynx.token) {
    jobs.push(
      travelynxCheckin(settings.travelynx, leg).then((r) => ['travelynx', r])
    )
  }
  const entries = await Promise.all(jobs)
  return Object.fromEntries(entries)
}
