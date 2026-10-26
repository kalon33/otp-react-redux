/**
 * Go Mode's clock, for modules that cannot import actions/go-mode.
 *
 * The tick runs on `getCurrentTime()` in actions/go-mode — wall time live, the
 * simulated clock under GPS simulation and replay. apiV2 needs the same "now"
 * to age a riding fact's evidence (70.3, `ridingRoutePreferred`), but
 * go-mode imports apiV2, and the reverse import made a cycle that let
 * `jest.mock('…/apiV2')` miss go-mode's own binding. So go-mode registers its
 * clock here when it loads; until then (a module tested without it) this is
 * the wall clock.
 */
let clock: () => number = () => Date.now()

export function registerGoModeClock(fn: () => number): void {
  clock = fn
}

export function goModeClockMs(): number {
  return clock()
}
