import { MobileScreens } from '../../../lib/actions/ui-constants'
import { returnToGoMode } from '../../../lib/actions/go-mode'

/**
 * 2026-09-09, session mtu45mqw-co4i61: the rider tapped "tap to return to your
 * trip" four times from the feedback page and nothing happened.
 *
 * `/feedback` and `/settings` are real routes in responsive-webapp's top-level
 * `<Switch>` (webapp-routes.js), rendering INSTEAD of the web app — so the
 * mobile-screen tree that `setMobileScreen(GO_MODE)` addresses is not mounted
 * at all. The action flipped every piece of state the banner reads
 * (SET_GO_MODE_BACKGROUNDED false + SET_MOBILE_SCREEN 10 at 08:33:43, again at
 * :48/:49/:51) with no LOCATION_CHANGE anywhere in the stream, and the rider
 * escaped only with the back gesture at 08:33:52.
 *
 * So the fix is a navigation, and this is the test for it: the same three
 * dispatches as before PLUS a router push back to `/`, carrying the query.
 */

/** connected-react-router's `push` lands as one of these. */
const ROUTER = '@@router/CALL_HISTORY_METHOD'

const makeStore = (pathname: string, search = '?ui_activeItinerary=0') => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actions: any[] = []
  const getState = () => ({
    otp: { ui: { mainPanelContent: null, viewedStop: null } },
    router: { location: { pathname, search } }
  })
  // Thunk-aware: routeTo is itself a thunk, and its push is the thing under
  // test, so recording it unrun would prove nothing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dispatch: any = (action: any) => {
    if (typeof action === 'function') return action(dispatch, getState)
    actions.push(action)
    return action
  }
  return {
    actions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    routerPushes: () => actions.filter((a: any) => a.type === ROUTER),
    run: () => returnToGoMode()(dispatch, getState),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    types: () => actions.map((a: any) => a.type)
  }
}

describe('returnToGoMode navigates out of a full-page route (13.3)', () => {
  it('pushes / from /feedback, preserving the query', () => {
    // FAILS BEFORE: no router action of any kind — the feedback page stayed
    // mounted over a trip that was, by every measure of state, in Go Mode.
    const store = makeStore('/feedback')
    store.run()
    const pushes = store.routerPushes()
    expect(pushes).toHaveLength(1)
    expect(pushes[0].payload.method).toBe('push')
    expect(pushes[0].payload.args).toEqual(['/?ui_activeItinerary=0'])
  })

  it('does the same from /settings, the other route the rider passed through', () => {
    const store = makeStore('/settings', '')
    store.run()
    expect(store.routerPushes()).toHaveLength(1)
    expect(store.routerPushes()[0].payload.args).toEqual(['/'])
  })

  it('still flips the state the banner and the mobile shell read', () => {
    const store = makeStore('/feedback')
    store.run()
    expect(store.types()).toContain('SET_GO_MODE_BACKGROUNDED')
    expect(store.types()).toContain('SET_MOBILE_SCREEN')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const screen = store.actions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a: any) => a.type === 'SET_MOBILE_SCREEN'
    )
    expect(screen.payload).toBe(MobileScreens.GO_MODE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bg = store.actions.find(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a: any) => a.type === 'SET_GO_MODE_BACKGROUNDED'
    )
    expect(bg.payload).toBe(false)
  })

  it('leaves the router alone when the rider is already on the app route', () => {
    // The common case — the banner tapped from the results list — must not
    // push a duplicate history entry under the rider's back gesture.
    const store = makeStore('/')
    store.run()
    expect(store.routerPushes()).toHaveLength(0)
    expect(store.types()).toEqual([
      'SET_GO_MODE_BACKGROUNDED',
      'SET_MOBILE_SCREEN'
    ])
  })

  it('survives a store with no router state at all', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actions: any[] = []
    const getState = () => ({
      otp: { ui: { mainPanelContent: null, viewedStop: null } }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      return action
    }
    expect(() => returnToGoMode()(dispatch, getState)).not.toThrow()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(actions.map((a: any) => a.type)).toContain('SET_MOBILE_SCREEN')
  })
})
