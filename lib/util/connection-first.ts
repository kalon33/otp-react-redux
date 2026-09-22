import { Leg } from '@opentripplanner/types'
import coreUtils from '@opentripplanner/core-utils'

import { ItineraryWithIndex } from './itinerary'

/**
 * Connection-first results (backlog 21.5).
 *
 * Today's results list is one row per route chain with its departure times on
 * the row. The rider asked for the other way round — 2026-09-21 16:03: "First
 * should be choosing the variants with both boarding and egress stops. Then
 * you can show time options once variant chosen" — and, on seeing a mock that
 * still printed times on the first screen, 2026-09-22 16:09: "Where do I select
 * the boarding stop? The egress stop? ... get rid of the times temporarily till
 * you figure this out". Ordered by "when you arrive" (09-22 11:01), and after
 * the two stops are picked, "just assume the next available time" (09-22
 * 12:00). No extra lookups: only the connections already in the answer.
 *
 * So the answer is regrouped into
 *
 *   boarding choice  (how you get there + where you get on)
 *     └ connection   (boarding platform, get-off stop gtfsId)
 *         └ departures, one per start minute, soonest first
 *
 * and both lists are ordered by the arrival of each option's next available
 * departure. Routes are a consequence of the two stops, never the key.
 *
 * Two things the key carries beyond the bare stop pair, both measured on the
 * rider's own 09:12 search (`0921-0912-search-responses.json`):
 *
 *  - the ACCESS MODE. The same Orange Line connection is in that answer both
 *    walked-to (1 490 m) and biked-to; those leave home at different minutes
 *    and a card cannot honestly say "bike 0.9 mi" for both. Walk and bike
 *    access are separate boarding choices, never merged and never hidden.
 *  - the same PLATFORM published by two agencies. `1:17781` (Metro Transit,
 *    "I-35W & Lake St Station") and `2:17781` (MVTA, "I-35W & Lake Street
 *    Station SB") share stop code 17781 and sit 21 m apart; the Orange Line
 *    boards at one and the 465 at the other. A rider standing there sees one
 *    station, so screen 1 shows one card for it (same code, within
 *    SAME_PLATFORM_METERS), and a connection is (that platform, the exact
 *    get-off gtfsId): the Orange Line then the 546 and the 465 then the 546
 *    both put a rider walking from Lake St down at "Old Shakopee Rd & Queen
 *    Ave S" (1:3452), and that is one place to get off reached two ways, not
 *    two cards with the same name. The get-off side is never merged by
 *    distance: the Orange to "I-35W & 98th St Station" and the 465 to "...
 *    Gate E" are 44 m apart with different codes, and stay two choices.
 */

/** Two stops with one code this close together are one platform. */
export const SAME_PLATFORM_METERS = 100

/**
 * A departure whose itinerary told the rider to leave home more than this long
 * ago is not "next available" any more.
 */
const DEPARTED_GRACE_MS = 60 * 1000

export interface ConnectionStop {
  code?: string
  gtfsId: string
  lat: number
  lon: number
  name: string
}

export interface Connection {
  /** Metres from the origin to the boarding stop (next departure's legs). */
  accessMeters: number
  /** Mode of the legs before the first transit leg (WALK, BICYCLE, ...). */
  accessMode: string
  alight?: ConnectionStop
  board?: ConnectionStop
  /**
   * The distinct route chains that make this connection, as the transit legs
   * of one itinerary each. Usually one; the same pair of stops can be served
   * by two chains.
   */
  chains: Leg[][]
  /** One itinerary per start minute, soonest first. */
  departures: ItineraryWithIndex[]
  /** No transit at all: bike (or walk) the whole way. */
  direct: boolean
  /** Metres from the get-off stop to the destination. */
  egressMeters: number
  /** Mode of the legs after the last transit leg. */
  egressMode: string
  key: string
  /** The next available departure — what the list is ordered by. */
  next: ItineraryWithIndex
}

export interface BoardingChoice {
  accessMeters: number
  accessMode: string
  /** Soonest arrival first. */
  connections: Connection[]
  direct: boolean
  key: string
  /** One first-transit leg per distinct route boarding here. */
  routes: Leg[]
  stop?: ConnectionStop
}

function isTransit(leg: Leg): boolean {
  return !!leg?.transitLeg
}

function stopOf(place: Leg['from']): ConnectionStop | undefined {
  const stop = place?.stop
  if (!stop?.gtfsId) return undefined
  return {
    code: stop.code || undefined,
    gtfsId: stop.gtfsId,
    lat: stop.lat ?? place.lat,
    lon: stop.lon ?? place.lon,
    name: place.name || stop.name || stop.gtfsId
  }
}

function metresBetween(a: ConnectionStop, b: ConnectionStop): number {
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.sqrt(h))
}

function sumDistance(legs: Leg[]): number {
  return legs.reduce((total, leg) => total + (leg.distance || 0), 0)
}

/** The mode that gets the rider from the origin to the first bus. */
function accessModeOf(accessLegs: Leg[]): string {
  if (accessLegs.some((leg) => leg.mode === 'BICYCLE')) return 'BICYCLE'
  if (accessLegs.some((leg) => leg.mode === 'CAR')) return 'CAR'
  return 'WALK'
}

/** The longest leg's mode, for an itinerary with no transit. */
function directModeOf(legs: Leg[]): string {
  const longest = [...legs].sort(
    (a, b) => (b.distance || 0) - (a.distance || 0)
  )[0]
  return longest?.mode || 'WALK'
}

function routeIdOf(leg: Leg): string {
  return (
    (typeof leg.route === 'object' ? leg.route?.id : '') ||
    leg.routeId ||
    leg.routeShortName ||
    leg.routeLongName ||
    ''
  )
}

/**
 * The next departure the rider can still make: the first whose itinerary does
 * not ask them to have left home already. A search for later in the day has
 * every departure in the future, so this is simply the first; a stale "leave
 * now" answer skips the ones that have gone. If every one has gone, the first.
 */
export function nextAvailable(
  departures: ItineraryWithIndex[],
  now: number
): ItineraryWithIndex {
  return (
    departures.find((itin) => itin.startTime >= now - DEPARTED_GRACE_MS) ||
    departures[0]
  )
}

/**
 * Regroup a search's itineraries into boarding choices and connections, both
 * ordered by when the rider would arrive on each one's next available
 * departure. Nothing is dropped: every itinerary lands in exactly one
 * connection, and an itinerary with no transit (bike the whole way) is its
 * own boarding choice with one connection.
 */
export function groupConnections(
  itineraries: ItineraryWithIndex[],
  now: number = Date.now()
): BoardingChoice[] {
  const connections = new Map<
    string,
    Omit<
      Connection,
      'departures' | 'next' | 'accessMeters' | 'egressMeters' | 'egressMode'
    > & {
      all: ItineraryWithIndex[]
    }
  >()
  // Boarding platform identity: gtfsId -> the gtfsId that stands for its
  // platform (the first one seen with the same code nearby).
  const platforms: ConnectionStop[] = []
  const platformStop = new Map<string, ConnectionStop>()
  const platformOf = (stop: ConnectionStop): string => {
    const same = platforms.find(
      (known) =>
        known.gtfsId === stop.gtfsId ||
        (!!known.code &&
          known.code === stop.code &&
          metresBetween(known, stop) <= SAME_PLATFORM_METERS)
    )
    if (same) {
      // Name the platform by its plainest name: the MVTA copy of Lake St
      // carries a feed suffix ("... Station SB") the Metro Transit one lacks.
      const named = platformStop.get(same.gtfsId)
      if (named && stop.name.length < named.name.length) {
        platformStop.set(same.gtfsId, stop)
      }
      return same.gtfsId
    }
    platforms.push(stop)
    platformStop.set(stop.gtfsId, stop)
    return stop.gtfsId
  }
  const choiceKeyOf = new Map<string, string>()

  ;(itineraries || []).forEach((itin) => {
    if (!itin?.legs?.length) return
    const legs = itin.legs
    const first = legs.findIndex(isTransit)
    let key: string
    let choiceKey: string
    if (first === -1) {
      const mode = directModeOf(legs)
      key = `direct|${mode}`
      choiceKey = key
      if (!connections.has(key)) {
        connections.set(key, {
          accessMode: mode,
          all: [],
          chains: [],
          direct: true,
          key
        })
      }
    } else {
      let last = first
      legs.forEach((leg, i) => {
        if (isTransit(leg)) last = i
      })
      const board = stopOf(legs[first].from)
      const alight = stopOf(legs[last].to)
      const accessMode = accessModeOf(legs.slice(0, first))
      const boardId = board ? platformOf(board) : legs[first].from?.name || '?'
      const alightId = alight?.gtfsId || legs[last].to?.name || '?'
      key = `${accessMode}|${boardId}|${alightId}`
      choiceKey = `${accessMode}|${boardId}`
      if (!connections.has(key)) {
        connections.set(key, {
          accessMode,
          alight,
          all: [],
          board,
          chains: [],
          direct: false,
          key
        })
      }
      const connection = connections.get(key)
      const chain = legs.filter(isTransit)
      const signature = chain.map(routeIdOf).join('>')
      if (
        connection &&
        !connection.chains.some(
          (known) => known.map(routeIdOf).join('>') === signature
        )
      ) {
        connection.chains.push(chain)
      }
    }
    connections.get(key)?.all.push(itin)
    choiceKeyOf.set(key, choiceKey)
  })

  const built: Connection[] = []
  connections.forEach(({ all, ...rest }) => {
    // One departure per start minute; where two share a minute the one that
    // arrives first stands for it.
    const byMinute = new Map<number, ItineraryWithIndex>()
    all.forEach((itin) => {
      const minute = Math.floor(itin.startTime / 60000)
      const held = byMinute.get(minute)
      if (!held || itin.endTime < held.endTime) byMinute.set(minute, itin)
    })
    const departures = Array.from(byMinute.values()).sort(
      (a, b) => a.startTime - b.startTime || a.endTime - b.endTime
    )
    const next = nextAvailable(departures, now)
    const first = next.legs.findIndex(isTransit)
    let last = first
    next.legs.forEach((leg, i) => {
      if (isTransit(leg)) last = i
    })
    built.push({
      ...rest,
      accessMeters: rest.direct
        ? sumDistance(next.legs)
        : sumDistance(next.legs.slice(0, first)),
      departures,
      egressMeters: rest.direct ? 0 : sumDistance(next.legs.slice(last + 1)),
      egressMode: rest.direct
        ? rest.accessMode
        : accessModeOf(next.legs.slice(last + 1)),
      next
    })
  })

  const byArrival = (a: Connection, b: Connection) =>
    a.next.endTime - b.next.endTime || a.next.startTime - b.next.startTime

  const choices = new Map<string, BoardingChoice>()
  built.sort(byArrival).forEach((connection) => {
    const choiceKey = choiceKeyOf.get(connection.key) || connection.key
    let choice = choices.get(choiceKey)
    if (!choice) {
      // Connections arrive soonest-first, so the first to open a choice is
      // its soonest option and names its stop and access distance.
      choice = {
        accessMeters: connection.accessMeters,
        accessMode: connection.accessMode,
        connections: [],
        direct: connection.direct,
        key: choiceKey,
        routes: [],
        // Named for the platform, so the walk and bike cards for one station
        // read the same.
        stop:
          (connection.board && platformStop.get(choiceKey.split('|')[1])) ||
          connection.board
      }
      choices.set(choiceKey, choice)
    }
    choice.connections.push(connection)
    connection.chains.forEach((chain) => {
      const firstLeg = chain[0]
      if (
        firstLeg &&
        !choice?.routes.some((leg) => routeIdOf(leg) === routeIdOf(firstLeg))
      ) {
        choice?.routes.push(firstLeg)
      }
    })
  })
  // Map insertion order is already soonest-arrival-first.
  return Array.from(choices.values())
}

/** Arrival of a choice's soonest option: the order both lists follow. */
export function choiceArrival(choice: BoardingChoice): number {
  return choice.connections[0]?.next.endTime ?? Infinity
}

/**
 * The shape the existing departure chips read (`allStartTimes`, 23.1), built
 * from a connection's own departures rather than from the route-signature
 * merge, so screen 3's chips are exactly this connection's buses.
 */
export function connectionStartTimes(connection: Connection): {
  itinerary: ItineraryWithIndex
  legs: Leg[]
  realtime: boolean
}[] {
  return connection.departures.map((itinerary) => ({
    itinerary,
    legs: itinerary.legs,
    realtime: !!itinerary.legs.find(isTransit)?.realTime
  }))
}

// ---------------------------------------------------------------------------
// The flag. Off unless the rider turns it on (Settings > Results), so the dev
// bundle behaves exactly as before for anyone who has not.
// ---------------------------------------------------------------------------

/** Local-storage key (core-utils prefixes it with "otp."). */
export const CONNECTION_FIRST_STORAGE_KEY = 'connectionFirstResults'

let cachedFlag: boolean | null = null

/**
 * Is the connection-first list on? Read from storage once and cached, because
 * the results list asks on every store change. A `?connectionFirst=1` (or
 * `=0`) in the URL sets it, for the browser and for testing.
 */
export function isConnectionFirstEnabled(): boolean {
  if (cachedFlag === null) {
    let fromUrl: string | null = null
    try {
      const match = /[?&]connectionFirst=([01])/.exec(
        typeof window !== 'undefined' ? window.location.href : ''
      )
      fromUrl = match ? match[1] : null
    } catch (e) {
      fromUrl = null
    }
    if (fromUrl !== null) {
      setConnectionFirstEnabled(fromUrl === '1')
    } else {
      const stored = coreUtils.storage.getItem(
        CONNECTION_FIRST_STORAGE_KEY,
        null
      ) as { enabled?: unknown } | null
      cachedFlag = stored?.enabled === true
    }
  }
  return !!cachedFlag
}

export function setConnectionFirstEnabled(enabled: boolean): void {
  cachedFlag = enabled
  try {
    coreUtils.storage.storeItem(CONNECTION_FIRST_STORAGE_KEY, { enabled })
  } catch (e) {
    // Storage can be unavailable (private mode); the flag still holds for
    // this session.
  }
}

/** Tests only: forget the cached value. */
export function resetConnectionFirstFlagCache(): void {
  cachedFlag = null
}
