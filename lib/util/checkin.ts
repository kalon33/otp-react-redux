/**
 * Check-in with the two German journey-logging services, Träwelling
 * (https://traewelling.de/api/documentation) and travelynx
 * (https://travelynx.de/api), from the legs of an OTP itinerary.
 *
 * The two services are addressed in parallel and independently: either, both
 * or neither can be configured in Settings, and each keeps its own token on
 * the device (util/checkin-settings).
 *
 * Träwelling has no "check in by name" endpoint — its documented flow is
 * departures → trip → checkin, all against its own HAFAS backend. So a leg is
 * resolved first: the departures board of the leg's boarding stop is searched
 * for the leg's line around the leg's departure, the matching departure's
 * trip is fetched, and the two stopovers that match the leg's from/to stops
 * become the checkin's origin and destination.
 *
 * travelynx accepts a checkin by train type/number and station names in one
 * call (`POST /api/v1/travel`). Names must match what its backend knows, so
 * the same resolution caveat applies, but there is nothing to look up first.
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

/** ISO datetime in Träwelling's format, from a stopover or an epoch ms. */
function trawellingWhen(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19)
}

/**
 * Resolve and check a leg into Träwelling, following its documented
 * departures → trip → checkin flow.
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

  // 1. The departures board of the boarding stop, around the departure.
  const departuresUrl =
    `${base}/v1/trains/departures` +
    `?station=${encodeURIComponent(fromName)}` +
    `&when=${encodeURIComponent(trawellingWhen(start))}`
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
    if (!d?.tripId) return false
    if (line && String(d.line ?? '') !== line) return false
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

  // 2. The trip behind that departure, to resolve the two stopovers.
  const tripUrl =
    `${base}/v1/trains/trip` +
    `?tripId=${encodeURIComponent(departure.tripId)}` +
    `&line=${encodeURIComponent(String(departure.line ?? line))}` +
    `&start=${encodeURIComponent(String(departure.stop?.id ?? ''))}`
  const trip = await readJson(tripUrl, { headers: bearer(settings.token) })
  if (!trip.ok) {
    return { error: trawellingError(trip.json, trip.status), ok: false }
  }
  const stopovers: any[] = trip.json?.data?.stopover ?? []
  const startStopover = stopovers.find(
    (s: any) =>
      String(s?.id) === String(departure.stop?.id) || s?.name === fromName
  )
  const destStopover = stopovers.find((s: any) => s?.name === toName)
  if (!startStopover || !destStopover) {
    return {
      error: `${fromName} → ${toName} is not part of the ${
        line || 'trip'
      } journey found.`,
      ok: false
    }
  }

  // 3. The checkin itself.
  const checkin = await readJson(`${base}/v1/trains/checkin`, {
    body: JSON.stringify({
      arrival: destStopover.arrival ?? destStopover.arrival_planned,
      departure: startStopover.departure ?? startStopover.departure_planned,
      destination: destStopover.id,
      line: String(departure.line ?? line),
      start: startStopover.id,
      tripId: departure.tripId
    }),
    headers: bearer(settings.token),
    method: 'POST'
  })
  if (!checkin.ok) {
    return { error: trawellingError(checkin.json, checkin.status), ok: false }
  }
  return {
    ok: true,
    statusId: checkin.json?.data?.status?.id
      ? String(checkin.json.data.status.id)
      : undefined
  }
}

/** Check a leg into travelynx with a single POST /api/v1/travel call. */
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
  const response = await readJson(`${base}/api/v1/travel`, {
    body: JSON.stringify({
      action: 'checkin',
      comment: undefined,
      fromStation: fromName,
      token: settings.token,
      toStation: toName,
      train: {
        no: line || undefined,
        type: travelynxTrainType(leg.mode ?? 'BUS')
      }
    }),
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
