import { differenceInMinutes } from 'date-fns'
import {
  FareProductSelector,
  Itinerary,
  Leg,
  Place
} from '@opentripplanner/types'
import { isTransitLeg } from '@opentripplanner/core-utils/lib/itinerary'
import { utcToZonedTime } from 'date-fns-tz'
import coreUtils from '@opentripplanner/core-utils'
import hash from 'object-hash'
import memoize from 'lodash.memoize'

import { AppConfig, CO2Config } from './config-types'
import { checkForRouteModeOverride } from './config'
import { WEEKDAYS, WEEKEND_DAYS } from './monitored-trip'

export interface ItineraryStartTime {
  itinerary: ItineraryWithIndex
  legs: Leg[]
  realtime: boolean
}

interface OtpResponse {
  plan: {
    itineraries: Itinerary[]
  }
}

export interface ItineraryWithIndex extends Itinerary {
  index: number
}

export interface ItineraryWithCO2Info extends Itinerary {
  co2: number
  co2VsBaseline: number
}

export interface ItineraryWithSortingCosts extends Itinerary {
  rank: number
  totalFare: number
  transitFare?: number
}

export interface ItineraryFareSummary {
  fareCurrency?: string
  maxTNCFare: number
  minTNCFare: number
  transitFare?: number
}

/**
 * Determines whether the specified Itinerary can be monitored.
 * @returns true if an itinerary has no rental or ride hail leg (e.g. CAR_RENT, CAR_HAIL, BICYCLE_RENT, etc.).
 *   (We use the corresponding fields returned by OTP to get transit legs and rental/ride hail legs.)
 */
export function itineraryCanBeMonitored(itinerary?: Itinerary): boolean {
  return (
    !!itinerary?.legs &&
    !itinerary.legs.some(
      (leg: Leg) => leg.rentedBike || !!leg.rideHailingEstimate
    )
  )
}

export function getMinutesUntilItineraryStart(itinerary: Itinerary): number {
  return differenceInMinutes(new Date(itinerary.startTime), new Date())
}

/**
 * Returns the set of monitored days that will be initially shown to the user
 * for the given itinerary.
 * @param itinerary The itinerary from which the default monitored days are extracted.
 * @returns ['monday' thru 'friday'] if itinerary happens on a weekday,
 *          ['saturday', 'sunday'] if itinerary happens on a saturday/sunday,
 *          based on the itinerary startTime.
 */
export function getItineraryDefaultMonitoredDays(
  itinerary: Itinerary,
  timeZone = coreUtils.time.getUserTimezone()
): string[] {
  const startDate = utcToZonedTime(new Date(itinerary.startTime), timeZone)
  const dayOfWeek = startDate.getDay()
  return dayOfWeek === 0 || dayOfWeek === 6 ? WEEKEND_DAYS : WEEKDAYS
}

/** Two leg endpoints at the same coordinates. Exported for the go-mode leg
 * merge, whose contiguity check needs the same notion of "same place". */
export function legLocationsAreEqual(legLocation: Place, other: Place) {
  return (
    !!legLocation &&
    !!other &&
    legLocation.lat === other.lat &&
    legLocation.lon === other.lon
  )
}

/**
 * The ordered list of routes an itinerary actually rides, ignoring how the
 * rider reaches the first stop and leaves the last one. This is the "shape" of
 * a trip: 465 > 94 > Gold Line is one shape whether you bike 4 miles or 6 at
 * the end. Empty for a walk- or bike-the-whole-way itinerary, which is why
 * callers must not treat two empty signatures as a match.
 */
export function transitRouteSignature(itinerary: Itinerary): string {
  return itinerary.legs
    .filter((leg) => leg.transitLeg)
    .map((leg) => leg.routeId ?? leg.mode)
    .join('>')
}

/**
 * Default length below which a CLOSING transit leg reads as a token hop rather
 * than a ride. 800 m, not the 500 m first proposed: the leg the rider actually
 * complained about ("Lmfao what is this route haha", 2026-08-31 17:32) was
 * **602 m** — board 98th St Gate C, ride to 98th & Dupont, then bike 1743 m
 * home — and 500 would have sailed straight past it. The nearest genuine ride
 * in the same OTP response was 1273 m, so 800 separates them with room on both
 * sides.
 */
export const TOKEN_TRANSIT_HOP_METERS = 800

/**
 * How much later the same journey WITHOUT the token hop may arrive and still
 * push the hop down the list. Five minutes, because the 08-31 pair missed a
 * three-minute window by five seconds: `Orange Line > bike 70 m > 539 602 m >
 * bike 1743 m` arrived 17:58:19 and `Orange Line > bike 3970 m` — the same
 * trip minus the hop — arrived 18:01:24, 3m05s later.
 */
export const TOKEN_TRANSIT_HOP_TOLERANCE_MS = 5 * 60 * 1000

/** The itinerary's transit legs, in order. */
export function transitLegs(itinerary: Itinerary): Leg[] {
  return itinerary.legs.filter((leg) => leg.transitLeg)
}

/**
 * The route signature this itinerary would have WITHOUT its final transit leg —
 * i.e. the shape of the same journey with the token hop dropped. Empty string
 * when the hop was the only transit leg, which is the legitimate "just ride/walk
 * the rest of the way" answer.
 */
export function signatureWithoutLastTransitLeg(itinerary: Itinerary): string {
  return transitLegs(itinerary)
    .map((leg) => leg.routeId ?? leg.mode)
    .slice(0, -1)
    .join('>')
}

/**
 * True when this itinerary ends with a transit leg so short, and a street leg
 * after it so long, that the vehicle bought the rider almost nothing.
 *
 * Both halves are required. A 400 m shuttle that sets the rider down at the
 * door is a fine last leg; what is not fine is riding 602 m and then cycling
 * 1743 m anyway, which is the shape the rider caught. The hop must also be
 * followed by a street leg — a token hop that ends the journey has nothing to
 * be replaced by.
 */
export function hasTokenTransitHop(
  itinerary: Itinerary,
  maxHopMeters: number = TOKEN_TRANSIT_HOP_METERS
): boolean {
  const legs = itinerary.legs
  const lastTransitIndex = legs.map((leg) => !!leg.transitLeg).lastIndexOf(true)
  if (lastTransitIndex < 0 || lastTransitIndex === legs.length - 1) return false
  const hop = legs[lastTransitIndex]
  if (!(hop.distance < maxHopMeters)) return false
  const after = legs
    .slice(lastTransitIndex + 1)
    .reduce((sum, leg) => sum + (leg.distance || 0), 0)
  return after > hop.distance
}

/**
 * Demote itineraries whose LAST transit leg is a token hop, when the same
 * journey without that hop is also on offer and arrives within a few minutes.
 *
 * Rider-caught 2026-08-31: a **602 m** ride on the 539 survived four replans
 * because `keepRouteId` pins the rider's chosen route and nothing ever asked
 * whether the kept leg was worth keeping. The same OTP response carried the
 * hop-free version of the trip; it was simply further down. This does not
 * remove anything and does not touch the router — it is a stable partition
 * (hop-free options first, in their existing order; token hops after, in
 * theirs), the same idiom narrative-itineraries already uses for a route lock.
 *
 * Deliberately NOT left to OTP's `transit-vs-street-filter`: that compares a
 * transit itinerary against the DIRECT street itinerary for the whole trip, so
 * it can never see that `Orange Line > bike > 539(602 m) > bike` is beaten by
 * `Orange Line > bike`. The comparison that matters is against the same trip
 * minus its final hop, and only the client holds both.
 */
export function demoteTokenTransitHops<T extends Itinerary>(
  itineraries: T[],
  options: { maxHopMeters?: number; toleranceMs?: number } = {}
): T[] {
  return demoteTokenTransitHopsBy(
    itineraries,
    (itinerary) => itinerary,
    options
  )
}

/**
 * The same partition over anything that CARRIES an itinerary — the onboard
 * optimizer ranks `{stopId, busArrivalEpoch, itinerary}` options, not bare
 * itineraries, and the rider is owed the same answer whether the 602 m hop
 * shows up in the results list or in "where do I get off this bus".
 */
export function demoteTokenTransitHopsBy<T>(
  items: T[],
  getItinerary: (item: T) => Itinerary,
  {
    maxHopMeters = TOKEN_TRANSIT_HOP_METERS,
    toleranceMs = TOKEN_TRANSIT_HOP_TOLERANCE_MS
  }: { maxHopMeters?: number; toleranceMs?: number } = {}
): T[] {
  const itineraries = items || []
  if (itineraries.length < 2) return itineraries

  // Earliest arrival on offer for each transit-route shape, so an itinerary can
  // ask "is the version of me without my last hop available, and when does it
  // land?" The empty signature (walk/bike the whole way) is a legitimate answer
  // here — it is exactly the "just ride to the destination" option.
  const earliestEndBySignature = new Map<string, number>()
  itineraries.forEach((item) => {
    const itin = getItinerary(item)
    const signature = transitRouteSignature(itin)
    const end = Number(itin.endTime)
    if (!Number.isFinite(end)) return
    const known = earliestEndBySignature.get(signature)
    if (known === undefined || end < known) {
      earliestEndBySignature.set(signature, end)
    }
  })

  const isDemoted = (item: T): boolean => {
    const itin = getItinerary(item)
    if (!hasTokenTransitHop(itin, maxHopMeters)) return false
    const withoutHop = signatureWithoutLastTransitLeg(itin)
    const alternativeEnd = earliestEndBySignature.get(withoutHop)
    if (alternativeEnd === undefined) return false
    return alternativeEnd <= Number(itin.endTime) + toleranceMs
  }

  const kept: T[] = []
  const demoted: T[] = []
  itineraries.forEach((item) => (isDemoted(item) ? demoted : kept).push(item))
  if (demoted.length === 0 || kept.length === 0) return itineraries
  return [...kept, ...demoted]
}

export function itinerariesAreEqual(
  itinerary: Itinerary,
  other: Itinerary,
  defaultFareType: FareProductSelector,
  // When true, two itineraries are "equal" if they ride the same routes in the
  // same order — the access and egress legs are not compared at all. OTP will
  // happily return the same chain three times over, alighting a stop or two
  // apart so the closing bike leg is 4.2, 5.0 and 6.3 miles; those are one
  // trip to a rider, and spending three result rows on them pushes genuinely
  // different options (the Orange Line variant of the same journey) off the
  // bottom of the list. The merge keeps the soonest departure and hangs the
  // rest on it as alternate start times, so nothing is actually lost.
  // When false (default), legs are matched by mode + stop location only, which
  // also folds alternate routes serving the same stops together.
  requireSameRoute = false
): boolean {
  if (requireSameRoute) {
    const signature = transitRouteSignature(itinerary)
    // No transit at all (walk- or bike-only): there is no shape to compare, so
    // fall through to the stricter leg-by-leg test rather than collapsing
    // every non-transit itinerary into one.
    if (signature !== '') {
      return (
        signature === transitRouteSignature(other) &&
        getFare(itinerary, defaultFareType).transitFare ===
          getFare(other, defaultFareType).transitFare
      )
    }
  }
  return (
    getFare(itinerary, defaultFareType).transitFare ===
      getFare(other, defaultFareType).transitFare &&
    itinerary.legs.length === other.legs.length &&
    itinerary.legs.every((leg, index) => {
      const otherLeg = other?.legs?.[index]
      return (
        otherLeg.mode === leg.mode &&
        legLocationsAreEqual(otherLeg?.to, leg?.to) &&
        legLocationsAreEqual(otherLeg?.from, leg?.from)
      )
    })
  )
}

export function getFirstLegStartTime(legs: Leg[]): number {
  return +legs[0].startTime
}

export function getLastLegEndTime(legs: Leg[]): number {
  return +legs[legs.length - 1].endTime
}

export function sortStartTimes(
  startTimes: ItineraryStartTime[]
): ItineraryStartTime[] {
  return startTimes?.sort(
    (a, b) => getFirstLegStartTime(a.legs) - getFirstLegStartTime(b.legs)
  )
}

// Ignore certain keys that could add significant calculation time to hashing.
// The alerts are irrelevant, but the intermediateStops, legGeometry and
// steps could have the legGeometry substitute as an equivalent hash value
const blackListedKeys = ['alerts', 'intermediateStops', 'legGeometry', 'steps']

// make blackListedKeys into an object due to superior lookup performance
const blackListedKeyLookup: Record<string, boolean> = {}
blackListedKeys.forEach((key) => {
  blackListedKeyLookup[key] = true
})

/**
 * A memoized function to hash the itinerary.
 * NOTE: It can take a while (>30ms) for the object-hash library to calculate
 * an itinerary's hash for some lengthy itineraries. If better performance is
 * desired, additional values to blackListedKeys should be added to avoid
 * spending extra time hashing values that wouldn't result in different
 * itineraries.
 */
const hashItinerary = memoize((itinerary) =>
  hash(itinerary, { excludeKeys: (key) => blackListedKeyLookup[key] })
)

/**
 * Returns a list of itineraries from the redux-stored responses, without duplicates.
 */
export function collectItinerariesWithoutDuplicates(
  response: OtpResponse[]
): ItineraryWithIndex[] {
  const itineraries: ItineraryWithIndex[] = []
  // keep track of itinerary hashes in order to not include duplicate
  // itineraries. Duplicate itineraries can occur in batch routing where a walk
  // to transit trip can sometimes still be the most optimal trip even when
  // additional modes such as bike rental were also requested
  const seenItineraryHashes: Record<string, boolean> = {}
  response?.forEach((res) => {
    res?.plan?.itineraries?.forEach((itinerary) => {
      // hashing takes a while on itineraries
      const itineraryHash = hashItinerary(itinerary)
      if (!seenItineraryHashes[itineraryHash]) {
        itineraries.push({ ...itinerary, index: itineraries.length })
        seenItineraryHashes[itineraryHash] = true
      }
    })
  })

  return itineraries
}

/**
 * Whether an itinerary is car-only.
 */
function isCarOnly(itin: Pick<Itinerary, 'legs'>) {
  return itin.legs.length === 1 && itin.legs[0].mode.startsWith('CAR')
}

/**
 * Returns a car itinerary if there is one, otherwise returns false.
 */
function getCarItinerary(itineraries: Pick<Itinerary, 'legs'>[]) {
  return (
    !!itineraries.filter(isCarOnly).length && itineraries.filter(isCarOnly)[0]
  )
}

/**
 * Compute the carbon emitted while driving (the baseline for comparison).
 */
function computeCarbonBaseline(itineraries: Itinerary[], co2Config: CO2Config) {
  // Sums the sum of the leg distances for each leg
  const avgDistance =
    itineraries.reduce(
      (sum, itin) =>
        sum + itin.legs.reduce((legsum, leg) => legsum + leg.distance, 0),
      0
    ) / itineraries.length

  // If we do not have a drive yourself itinerary, estimate the distance based on avg of transit distances.
  return coreUtils.itinerary.calculateEmissions(
    getCarItinerary(itineraries) || {
      legs: [{ distance: avgDistance, mode: 'CAR' }] as Leg[]
    },
    co2Config?.carbonIntensity,
    co2Config?.massUnit
  )
}

/**
 * Add carbon info to an itinerary.
 */
function addCarbonInfo<T extends Itinerary>(
  itin: T,
  co2Config: CO2Config,
  baselineCo2: number
) {
  const emissions = coreUtils.itinerary.calculateEmissions(
    itin,
    co2Config?.carbonIntensity,
    co2Config?.massUnit
  )
  return {
    ...itin,
    co2: emissions,
    co2VsBaseline: (emissions - baselineCo2) / baselineCo2
  }
}

/**
 * Add carbon info to the given set of itineraries.
 */
export function addCarbonInfoToAll<T extends Itinerary>(
  itineraries: T[],
  co2Config: CO2Config
): ItineraryWithCO2Info[] {
  const baselineCo2 = computeCarbonBaseline(itineraries, co2Config)
  return (
    itineraries?.map((itin) => addCarbonInfo(itin, co2Config, baselineCo2)) ||
    []
  )
}

/**
 * Get total drive time (i.e., total duration for legs with mode=CAR) for an
 * itinerary.
 */
function getDriveTime(itinerary: Itinerary): number {
  if (!itinerary) return 0
  let driveTime = 0
  itinerary.legs.forEach((leg) => {
    if (leg.mode === 'CAR') driveTime += leg.duration
  })
  return driveTime
}

/**
 * Parses OTP itinerary fare object and returns fares along with overridden currency
 */
export function getFare(
  itinerary: Itinerary,
  defaultFareType?: FareProductSelector
): ItineraryFareSummary {
  const { maxTNCFare, minTNCFare } =
    coreUtils.itinerary.calculateTncFares(itinerary)

  const itineraryCost = coreUtils.itinerary.getItineraryCost(
    itinerary?.legs,
    defaultFareType?.mediumId || null,
    defaultFareType?.riderCategoryId || null
  )

  return {
    fareCurrency: itineraryCost?.currency.code,
    maxTNCFare,
    minTNCFare,
    transitFare: itineraryCost?.amount
  }
}

/**
 * Default costs for modes that currently have no costs evaluated in
 * OpenTripPlanner.
 */
const DEFAULT_COSTS = {
  // $2 per trip? This is a made up number.
  bikeshareTripCostCents: 2 * 100,
  // $2 for 3 hours of parking?
  carParkingCostCents: 3 * 2.0 * 100,
  // FL per diem rate: https://www.flcourts.org/content/download/219314/1981830/TravelInformation.pdf
  drivingCentsPerMile: 0.445 * 100
}

/**
 * Returns total fare for itinerary (in cents)
 * FIXME: Move to otp-ui?
 * TODO: Add GBFS fares
 */
export function getTotalFare(
  itinerary: Itinerary,
  configCosts = {},
  defaultFareType: FareProductSelector = {
    mediumId: undefined,
    riderCategoryId: undefined
  }
): number | null {
  // Get TNC fares.
  const { maxTNCFare, transitFare } = getFare(itinerary, defaultFareType)
  // Start with default cost values.
  const costs = DEFAULT_COSTS
  // If config contains values to override defaults, apply those.
  if (configCosts) Object.assign(costs, configCosts)
  // Calculate total cost from itinerary legs.
  let drivingCost = 0
  let hasBikeshare = false
  let transitFareNotProvided = false
  let rideHailTrip = false
  itinerary.legs.forEach((leg) => {
    rideHailTrip = rideHailTrip || !!leg?.rideHailingEstimate
    if (leg.mode === 'CAR' && !rideHailTrip) {
      // Convert meters to miles and multiple by cost per mile.
      drivingCost += leg.distance * 0.000621371 * costs.drivingCentsPerMile
    }
    if (
      leg.mode === 'BICYCLE_RENT' ||
      leg.mode === 'MICROMOBILITY' ||
      leg.mode === 'SCOOTER' ||
      leg.rentedBike
    ) {
      hasBikeshare = true
    }
    if (isTransitLeg(leg) && transitFare == null) {
      transitFareNotProvided = true
    }
  })
  // If our itinerary includes a transit leg, but transit fare data is not provided
  // return no fare information, rather than an underestimate
  if (transitFareNotProvided) return null
  const bikeshareCost = hasBikeshare ? costs.bikeshareTripCostCents : 0
  // If some leg uses driving, add parking cost to the total.
  if (drivingCost > 0 && !rideHailTrip) drivingCost += costs.carParkingCostCents
  return bikeshareCost + drivingCost + (transitFare || 0) + maxTNCFare * 100
}

/**
 * Default constants for calculating itinerary "cost", i.e., how preferential a
 * particular itinerary is based on factors like wait time, total fare, drive
 * time, etc.
 */
const DEFAULT_WEIGHTS = {
  driveReluctance: 2,
  durationFactor: 0.25,
  fareFactor: 0.5,
  transferReluctance: 0.9,
  waitReluctance: 0.1,
  walkReluctance: 0.1
}

/**
 * This calculates the "cost" (not the monetary cost, but the cost according to
 * multiple factors like duration, total fare, and walking distance) for a
 * particular itinerary, for use in sorting itineraries.
 * FIXME: Do major testing to get this right.
 */
export function calculateItineraryCost(
  itinerary: Itinerary,
  config: Pick<AppConfig, 'itinerary'> = {}
): number {
  // Initialize weights to default values.
  const weights = DEFAULT_WEIGHTS
  // If config contains values to override defaults, apply those.
  const configWeights = config.itinerary && config.itinerary.weights
  if (configWeights) Object.assign(weights, configWeights)
  return (
    (getTotalFare(
      itinerary,
      config.itinerary?.costs,
      config.itinerary?.defaultFareType
    ) || 0) *
      weights.fareFactor +
    itinerary.duration * weights.durationFactor +
    (itinerary.walkDistance || 0) * weights.walkReluctance +
    getDriveTime(itinerary) * weights.driveReluctance +
    itinerary.waitingTime * weights.waitReluctance +
    (itinerary.transfers || 0) * weights.transferReluctance
  )
}

/**
 * Computes and add cost attributes to avoid recomputing those costs during sorting.
 */
export function addSortingCosts<T extends Itinerary>(
  itinerary: T,
  config: AppConfig
): ItineraryWithSortingCosts {
  const configCosts = config.itinerary?.costs
  const totalFareResult = getTotalFare(itinerary, configCosts)
  const totalFare =
    totalFareResult === null ? Number.MAX_VALUE : totalFareResult

  const rank = calculateItineraryCost(itinerary, config)
  const transitFare = getFare(itinerary).transitFare
  return {
    ...itinerary,
    rank,
    totalFare,
    transitFare
  }
}

interface LegWithOriginalMode extends Leg {
  originalMode?: string
}

/** Applies route mode overrides to an itinerary. */
export function applyRouteModeOverrides(
  itinerary: Itinerary,
  routeModeOverrides: Record<string, string>
): void {
  itinerary.legs.forEach((leg: LegWithOriginalMode) => {
    // Use OTP2 leg route first, fallback on legacy leg routeId.
    const routeId = typeof leg.route === 'object' ? leg.route.id : leg.routeId
    if (routeId) {
      leg.originalMode = leg.mode
      leg.mode = checkForRouteModeOverride(
        {
          id: routeId,
          mode: leg.mode
        },
        routeModeOverrides
      )
    }
  })
}

/** Remove mode overrides from an itinerary */
export function copyAndRemoveRouteModeOverrides(
  itinerary: Itinerary
): Itinerary {
  return {
    ...itinerary,
    legs: itinerary.legs.map((leg: LegWithOriginalMode) => ({
      ...leg,
      mode: leg.originalMode || leg.mode
    }))
  }
}
