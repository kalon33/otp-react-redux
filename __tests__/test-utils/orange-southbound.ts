/**
 * A synthetic SOUTHBOUND Orange Line run for backlog 49.1 ("We need different
 * boarding stops not just different egress stops!", 2026-10-13 09:12). Built
 * from the recorded northbound trip 1:1346795
 * (mock-data/other-stops-0923-1537.json): the same stops and running times,
 * reversed, minus the downtown layover. The rider's search that morning ran
 * from Powderhorn (44.94246,-93.26398) to 2345 Old Shakopee Rd W: Lake St is
 * the nearest Orange Line stop, every stop before it on a southbound run is
 * downtown and farther, and 46th St comes after it.
 */
import { decode, encode } from '@mapbox/polyline'

import recorded from './mock-data/other-stops-0923-1537.json'

const rec = recorded as any

export const POWDERHORN = { lat: 44.94246, lon: -93.26398, name: 'Powderhorn' }
export const OLD_SHAKOPEE = {
  lat: 44.8237,
  lon: -93.305,
  name: '2345 Old Shakopee Road W'
}

/** 2026-10-13 00:00 CDT, the service day. */
const SERVICE_DAY = 1791867600
/** The run leaves the first downtown stop at 9:15 AM. */
const FIRST_DEPARTURE = 9 * 3600 + 15 * 60

const northbound = rec.trip.stopTimes.filter(
  (st: any) => st.stop.name !== 'Gateway Ramp Layover'
)
const lastNorth = northbound[northbound.length - 1].scheduledDeparture

export const southboundTrip: any = {
  geometry: {
    points: encode(
      (decode(rec.trip.geometry.points) as [number, number][]).reverse()
    )
  },
  id: '1:9049001',
  route: rec.trip.route,
  stopTimes: [...northbound].reverse().map((st: any) => {
    const sd = FIRST_DEPARTURE + (lastNorth - st.scheduledDeparture)
    return {
      ...st,
      arrivalDelay: 0,
      realtimeArrival: sd,
      realtimeState: 'SCHEDULED',
      scheduledArrival: sd,
      scheduledDeparture: sd,
      serviceDay: SERVICE_DAY
    }
  }),
  tripHeadsign: 'Burnsville'
}

const stIndex = (name: string) =>
  southboundTrip.stopTimes.findIndex((st: any) => st.stop.name === name)
const epochAt = (name: string) => {
  const st = southboundTrip.stopTimes[stIndex(name)]
  return (st.serviceDay + st.scheduledDeparture) * 1000
}

function stopPlace(name: string, extra: any = {}) {
  const { stop } = southboundTrip.stopTimes[stIndex(name)]
  return {
    lat: stop.lat,
    lon: stop.lon,
    name: stop.name,
    stop: { code: stop.code, gtfsId: stop.id, id: stop.id },
    stopId: stop.id,
    vertexType: 'TRANSIT',
    ...extra
  }
}

/** Straight-line metres, enough for a synthetic street leg's distance. */
export function metresBetween(a: any, b: any): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** A bike leg between two places at 4.5 m/s over 1.3x the straight line. */
export function bikeLeg(from: any, to: any, startTime: number): any {
  const distance = Math.round(metresBetween(from, to) * 1.3)
  const duration = Math.round(distance / 4.5)
  return {
    distance,
    duration,
    endTime: startTime + duration * 1000,
    from: { lat: from.lat, lon: from.lon, name: from.name },
    mode: 'BICYCLE',
    startTime,
    to: { lat: to.lat, lon: to.lon, name: to.name },
    transitLeg: false
  }
}

/**
 * The row's representative: bike from Powderhorn to Lake St, the Orange Line
 * from Lake St to `alight`, bike on to Old Shakopee Rd.
 */
export function southboundRepresentative(
  alight = 'I-35W & 98th St Station'
): any {
  const board = 'I-35W & Lake St Station'
  const busStart = epochAt(board)
  const busEnd = epochAt(alight)
  const accessTemplate = bikeLeg(POWDERHORN, stopPlace(board), 0)
  const access = bikeLeg(
    POWDERHORN,
    stopPlace(board),
    busStart - 120000 - accessTemplate.duration * 1000
  )
  const egress = bikeLeg(stopPlace(alight), OLD_SHAKOPEE, busEnd)
  const bus = {
    agencyId: '1:0',
    distance: 15000,
    duration: (busEnd - busStart) / 1000,
    endTime: busEnd,
    fareProducts: [],
    from: stopPlace(board, { departure: busStart }),
    headsign: 'Burnsville',
    mode: 'BUS',
    route: { id: '1:921', shortName: 'Orange' },
    routeId: '1:921',
    routeShortName: 'Orange',
    startTime: busStart,
    to: stopPlace(alight, { arrival: busEnd }),
    transitLeg: true,
    trip: { gtfsId: southboundTrip.id, id: southboundTrip.id },
    tripId: southboundTrip.id
  }
  const legs = [access, bus, egress]
  return {
    duration: (egress.endTime - access.startTime) / 1000,
    endTime: egress.endTime,
    legs,
    startTime: access.startTime,
    transfers: 0,
    waitingTime: 120
  }
}
