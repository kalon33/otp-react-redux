import clone from 'clone'
import type { Itinerary, Leg } from '@opentripplanner/types'

import type { LiveLegTime } from '../../actions/go-mode'

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

interface TimePoint {
  epoch: number | string | undefined
  realtime: boolean
}

/**
 * A transit leg's live alight time, falling back to the plan's own end time.
 *
 * The bus's times are the bus's: a bus departs when it departs, regardless of
 * how fast the rider walks. refreshLiveLegTimes re-polls GTFS-realtime mid-ride
 * (the RIDDEN trip once the rider is aboard) and stores a per-leg live arrival;
 * prefer it, else the plan leg's endTime — itself realtime-as-of-planning, else
 * schedule, which is why the fallback reports realtime: false.
 */
export function legAlight(
  i: number,
  leg: Leg,
  liveLegTimes: Record<number, LiveLegTime>
): TimePoint {
  const live = liveLegTimes[i]
  if (TRANSIT_MODES.has(leg.mode) && live?.alightEpoch) {
    // Per-field flag: the leg-level `realtime` is an OR across board and
    // alight, which kept styling a schedule-fallback alight time as live.
    return {
      epoch: live.alightEpoch,
      realtime: live.alightRealtime ?? live.realtime
    }
  }
  return { epoch: leg.endTime, realtime: false }
}

/** Board time, mirroring legAlight. */
export function legBoard(
  i: number,
  leg: Leg,
  liveLegTimes: Record<number, LiveLegTime>
): TimePoint {
  const live = liveLegTimes[i]
  if (TRANSIT_MODES.has(leg.mode) && live?.boardEpoch) {
    return {
      epoch: live.boardEpoch,
      realtime: live.boardRealtime ?? live.realtime
    }
  }
  return { epoch: leg.startTime, realtime: false }
}

/**
 * Fold Go Mode's live leg times back into the itinerary itself, so the ordinary
 * trip-planner components can render the live trip without knowing Go Mode
 * exists. The planner's time column (narrative/line-itin/realtime-time-column)
 * reads only leg.startTime / endTime / realTime / departureDelay / arrivalDelay
 * — set those from the live figures and it shows the rider's real board and
 * alight times, with the app's own realtime styling and delay text.
 *
 * Non-transit legs and legs with no live figure pass through untouched, so a
 * leg never claims to be live when it is only scheduled.
 */
export function buildLiveItinerary(
  itinerary: Itinerary,
  liveLegTimes: Record<number, LiveLegTime>
): Itinerary {
  const live = clone(itinerary)

  // How far the trip has slipped since the last transit leg. The itinerary
  // shows the time of the leg that STARTS at each place, so a bus arriving 3
  // min late only reads as late once the walk that follows it moves too —
  // without this the alight stop still showed the scheduled time (the very
  // thing "board / off" times were added to fix).
  //
  // Only access legs are shifted: a later bus departs when it departs no
  // matter how late this one runs, so reaching a transit leg resets the slip.
  let shift = 0

  live.legs = live.legs.map((leg: Leg, i: number) => {
    // The fare table does `transitLegs.flatMap(leg => leg.fareProducts)` and
    // then reads `.product` off every entry, so a transit leg with a MISSING
    // array puts `undefined` in that list and throws — taking the whole sheet
    // down mid-ride, when the rider needs it most. Go Mode splices its own
    // itineraries together (buildOnboardItinerary), so normalize at this
    // boundary rather than trusting every leg to be OTP-shaped.
    const anyLeg = leg as any
    if (TRANSIT_MODES.has(leg.mode)) {
      anyLeg.fareProducts = Array.isArray(anyLeg.fareProducts)
        ? anyLeg.fareProducts.filter(Boolean)
        : []
    }

    if (!TRANSIT_MODES.has(leg.mode)) {
      if (!shift) return leg
      const moved: any = { ...leg }
      const start = Number(leg.startTime)
      const end = Number(leg.endTime)
      if (Number.isFinite(start)) moved.startTime = start + shift
      if (Number.isFinite(end)) moved.endTime = end + shift
      return moved as Leg
    }

    shift = 0
    const board = legBoard(i, leg, liveLegTimes)
    const alight = legAlight(i, leg, liveLegTimes)
    const next: any = { ...leg }

    // The delay fields must always end up numeric: the time column computes
    // `time - delay * 1000` to show the scheduled time struck through, and an
    // undefined delay renders that as "Invalid Date".
    const boardMs = Number(board.epoch)
    if (board.realtime && Number.isFinite(boardMs)) {
      const scheduled = Number(leg.startTime)
      next.startTime = boardMs
      next.realTime = true
      next.departureDelay = Number.isFinite(scheduled)
        ? Math.round((boardMs - scheduled) / 1000)
        : 0
    }

    const alightMs = Number(alight.epoch)
    if (alight.realtime && Number.isFinite(alightMs)) {
      const scheduled = Number(leg.endTime)
      next.endTime = alightMs
      next.realTime = true
      if (Number.isFinite(scheduled)) {
        next.arrivalDelay = Math.round((alightMs - scheduled) / 1000)
        shift = alightMs - scheduled
      } else {
        next.arrivalDelay = 0
      }
    }

    return next as Leg
  })
  return live
}
