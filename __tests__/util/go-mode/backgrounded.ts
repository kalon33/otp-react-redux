import {
  setGoModeBackgrounded,
  startGoMode,
  stopGoMode
} from '../../../lib/actions/go-mode'
import goMode from '../../../lib/reducers/go-mode'

const initial = goMode(undefined, { type: '@@INIT' })

describe('go-mode backgrounded flag', () => {
  it('is off by default', () => {
    expect(initial.ui.backgrounded).toBe(false)
  })

  it('SET_GO_MODE_BACKGROUNDED toggles the flag without touching the rest of ui', () => {
    const on = goMode(initial, setGoModeBackgrounded(true))
    expect(on.ui.backgrounded).toBe(true)
    expect(on.ui.mapFollowUser).toBe(initial.ui.mapFollowUser)
    const off = goMode(on, setGoModeBackgrounded(false))
    expect(off.ui.backgrounded).toBe(false)
  })

  it('START_GO_MODE preserves backgrounded — an auto-update swapping the itinerary must not yank the rider out of the planner', () => {
    const backgrounded = goMode(
      goMode(initial, startGoMode({ itinerary: { legs: [] } as any })),
      setGoModeBackgrounded(true)
    )
    const swapped = goMode(
      backgrounded,
      startGoMode({ itinerary: { legs: [] } as any })
    )
    expect(swapped.isActive).toBe(true)
    expect(swapped.ui.backgrounded).toBe(true)
  })

  it('STOP_GO_MODE resets backgrounded with the rest of the trip state', () => {
    const backgrounded = goMode(
      goMode(initial, startGoMode({ itinerary: { legs: [] } as any })),
      setGoModeBackgrounded(true)
    )
    const stopped = goMode(backgrounded, stopGoMode())
    expect(stopped.isActive).toBe(false)
    expect(stopped.ui.backgrounded).toBe(false)
  })
})
