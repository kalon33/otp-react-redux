import { assessRiderGpsTrust } from './transit-trust'
import { getNextStopOnRide } from './next-stop'
import {
  RIDING_ESTABLISH_MIN_SPEED_MPS,
  ridingFactIsCurrent,
  ridingFactIsEvidenced
} from './riding'

/**
 * Where the search form's "Current Location" origin goes when the rider taps
 * Stop while they are CLEARLY riding a bus (backlog 51.2, cycle 24 Q1 = C):
 * the bus's next stop — a place they can act on — instead of a moving
 * mid-street GPS point. Null means "not clearly riding": the caller uses the
 * freshest GPS fix.
 *
 * 2026-10-17, ride `mvcx52b7-anqred`: Stop at 17:50:57.040 restored the
 * trip's 17:25 start point 44.94110,-93.21532 while the rider was on Orange
 * Line vehicle 1:8217 (trip 1:1368267) at 26.47 m/s, 2 s after a 3.1 m fix on
 * the route (leg 0, progress 0.633). Every gate below held then, and the
 * answer is I-35W & 66th St Station.
 *
 * "Clearly riding" is ALL of:
 * - Go Mode active with a riding fact anchored to a leg (`legIndex >= 0`) —
 *   the mid-ride search's own gate;
 * - the fact rests on a real vehicle id, not a synthetic `route:` one
 *   (`ridingFactIsEvidenced`), and is still about now (`ridingFactIsCurrent`);
 * - the rider's own fix is on the ridden leg's route, fresh and accurate
 *   (`assessRiderGpsTrust`);
 * - the fix is moving faster than `RIDING_ESTABLISH_MIN_SPEED_MPS` (a fix with
 *   no speed is NOT moving);
 * - there is a next stop on the ride.
 *
 * Bus detection rests on the live vehicle and the route geometry, never on
 * proximity to a stop. The bare `riding && nextStop` test is not enough: the
 * riding fact clears only on TRANSITION_LEG, so it is still set just after the
 * rider steps off — the speed and on-route gates are what tell them apart.
 *
 * `nowMs` is the clock the fix is aged against: wall time live, the fix's own
 * timestamp under simulation/replay (the same forcing `replanOriginPick` uses).
 */
export function stopOriginAboard(
  state: any,
  nowMs: number
): { lat: number; lon: number; name: string } | null {
  const goMode = state?.otp?.goMode
  const riding = goMode?.riding
  if (!goMode?.isActive || !riding || !(riding.legIndex >= 0)) return null
  if (!ridingFactIsEvidenced(riding)) return null
  const transitIndex = state?.otp?.transitIndex
  if (
    !ridingFactIsCurrent({
      nowMs,
      riding,
      trip: riding.tripId ? transitIndex?.trips?.[riding.tripId] ?? null : null,
      vehicles: riding.routeId
        ? transitIndex?.routes?.[riding.routeId]?.vehicles ?? null
        : null
    })
  ) {
    return null
  }

  const fix: GeolocationPosition | null = goMode.tracking?.lastPosition ?? null
  const at = Number(fix?.timestamp)
  if (!fix?.coords || !Number.isFinite(at)) return null
  if (
    !assessRiderGpsTrust({
      accuracy: fix.coords.accuracy,
      anchorLegIndex: riding.legIndex,
      fixAgeMs: nowMs - at,
      routeMatch: goMode.routeMatch ?? null
    })
  ) {
    return null
  }
  const speed = fix.coords.speed
  if (speed == null || !(speed > RIDING_ESTABLISH_MIN_SPEED_MPS)) return null

  const nextStop = getNextStopOnRide(state, nowMs)
  if (!nextStop) return null
  return { lat: nextStop.lat, lon: nextStop.lon, name: nextStop.name }
}
