import clone from 'clone'
import type { Itinerary, Leg } from '@opentripplanner/types'

import type { LiveLegTime } from './types'

const TRANSIT_MODES = new Set(['BUS', 'FERRY', 'RAIL', 'SUBWAY', 'TRAM'])

interface TimePoint {
  epoch: number | string | undefined
  /** Schedule shifted to where the bus actually is — an estimate, not a feed. */
  projected?: boolean
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
      projected: live.alightProjected,
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
      projected: live.boardProjected,
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

  // The end the transit leg before this one ACTUALLY has once the live figures
  // are in — the anchor the access leg that follows must hang off.
  //
  // The slip cannot be measured as (live alight − leg.endTime), which is what
  // this did until 2026-09-08. That assumes leg[i].startTime === leg[i-1].endTime,
  // and Go Mode's own itineraries break that: buildOnboardItinerary synthesizes
  // a bus leg ending at the LIVE arrival and grafts the pre-boarding plan's tail
  // onto it UNTOUCHED (actions/go-mode.ts buildOnboardItinerary → busLegEnd +
  // `onward.legs`; repairLegTimeInversions only ever pushes legs later, never
  // pulls them back). On the 11:23 Orange Line ride that left leg 0 ending at
  // the live 11:41:09 while leg 1 — the walk — still started at the plan's
  // 11:46:50, and since the sheet prints the START time of the leg beginning at
  // each place, the alight stop read "11:46 AM": five minutes of a bus ride the
  // rider was not going to take, with the correct figure sitting in
  // liveLegTimes[0].alightEpoch the whole time.
  //
  // Anchoring instead of delta-shifting is identical on a contiguous itinerary
  // (start === prev end makes the two arithmetics the same) and right on a
  // spliced one.
  let prevTransitEnd: number | null = null

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
      if (prevTransitEnd != null) {
        const start = Number(leg.startTime)
        shift = Number.isFinite(start) ? prevTransitEnd - start : 0
        prevTransitEnd = null
      }
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
    if (!board.realtime && board.projected && Number.isFinite(boardMs)) {
      next.startTime = boardMs
    }
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
      next.arrivalDelay = Number.isFinite(scheduled)
        ? Math.round((alightMs - scheduled) / 1000)
        : 0
    } else if (alight.projected && Number.isFinite(alightMs)) {
      // A projected time DOES get shown — the alternative is the plan's
      // build-time arrival, frozen at the moment the trip was planned and
      // wrong by however late the bus has since become (3m41s on the 8/16
      // run). What it does not get is `realTime`: this is the timetable
      // shifted to where the bus is, not something the feed said, and styling
      // it live would claim a confidence nobody has. Leaving realTime false is
      // the honest signal, and the delay fields stay untouched so the striking
      // -through of a "scheduled" time never fires on an estimate.
      next.endTime = alightMs
    }

    // board and alight are applied independently, so a live board time that
    // has moved later than a live alight time (or an alight prediction that
    // has fallen behind) leaves a leg arriving before it departs. Keep the
    // planned running time in that case — the rider can't arrive early by
    // boarding late.
    if (Number(next.endTime) < Number(next.startTime)) {
      const plannedRun = Number(leg.endTime) - Number(leg.startTime)
      next.endTime =
        Number(next.startTime) +
        (Number.isFinite(plannedRun) ? Math.max(0, plannedRun) : 0)
    }

    // Read AFTER the inversion clamp, so the walk hangs off the end the sheet
    // actually prints rather than the one the clamp threw away.
    const effectiveEnd = Number(next.endTime)
    prevTransitEnd = Number.isFinite(effectiveEnd) ? effectiveEnd : null

    return next as Leg
  })
  return live
}

/**
 * The live end of the trip: the last leg's end time once the live figures have
 * been folded in — i.e. exactly the arrival the trip sheet prints.
 *
 * Anything that shows the rider an arrival time should read this rather than
 * re-deriving one, so two surfaces cannot disagree. Returns null when the
 * itinerary has no usable end (no legs, or non-numeric times).
 */
export function liveArrivalMs(
  itinerary: Itinerary | null | undefined,
  liveLegTimes: Record<number, LiveLegTime>
): number | null {
  if (!itinerary?.legs?.length) return null
  const legs = buildLiveItinerary(itinerary, liveLegTimes || {}).legs
  const end = Number(legs[legs.length - 1]?.endTime)
  return Number.isFinite(end) ? end : null
}
