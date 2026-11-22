/**
 * The in-ride Direct / Calm / Wander switch (backlog 76.3).
 *
 * Choosing a mode on the trip sheet sets THIS trip's mode (goMode.exploreMode,
 * which every later re-plan of the bike leg reads), stores it as the rider's
 * preference for the next search (setBikeExploreMode, 76.2), and re-plans the
 * bike leg once, now, through the ordinary quiet access re-plan: the engine
 * first in Calm / Wander, OTP exactly as before in Direct. That re-plan keeps
 * every guard it has — aboard, transit pace, the fix, a reroute in flight —
 * and is only exempt from the deviation cooldown, which paces the re-plans the
 * app starts on its own, not the ones the rider asks for.
 */
import { ExploreMode, normalizeExploreMode } from '../util/bike-explore'
import {
  goModeExploreMode,
  isExploreAccessLeg,
  SET_GO_MODE_EXPLORE_MODE
} from '../util/go-mode/explore-replan'

import { quietReplanAccessLeg } from './go-mode'
import { setBikeExploreMode } from './bike-explore'

/** The leg the switch is about: the current one, a bike ride to a boarding. */
export function goModeOnExploreAccessLeg(goMode: any): boolean {
  const legs = goMode?.activeItinerary?.legs || []
  const index = goMode?.progress?.currentLegIndex ?? 0
  return isExploreAccessLeg(legs, index, index + 1)
}

export function chooseGoModeExploreMode(mode: ExploreMode) {
  return function (dispatch: any, getState: any): Promise<void> | void {
    const goMode = getState().otp?.goMode
    if (!goMode?.isActive) return
    const next = normalizeExploreMode(mode)
    const changed = goModeExploreMode(goMode) !== next
    dispatch(setBikeExploreMode(next))
    if (!changed) return
    dispatch({ payload: next, type: SET_GO_MODE_EXPLORE_MODE })
    if (!goModeOnExploreAccessLeg(goMode)) return
    return dispatch(quietReplanAccessLeg({ riderAsked: true }))
  }
}
