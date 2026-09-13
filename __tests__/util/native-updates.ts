import {
  BUNDLE_HEALTH_GRACE_MS,
  confirmBundleHealthyWhenStable
} from '../../lib/util/native-updates'

// The plugin reverts a freshly-installed bundle unless notifyAppReady() is
// called before its appReadyTimeout. That is the ONLY thing standing between a
// bad web bundle and a rider who cannot open the app, so what we confirm on
// matters: on 2026-09-02 the call sat on the line after ReactDOM.render, an
// old-shape routeLock threw inside a render, React unmounted the whole tree,
// and the bundle had already been pronounced healthy on the strength of
// render() having returned. See lib/util/native-updates.
describe('confirmBundleHealthyWhenStable', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('confirms a boot that renders and stays quiet', () => {
    const confirm = jest.fn()
    confirmBundleHealthyWhenStable({ confirm, hasRendered: () => true })

    // Not on the spot — the whole point is that it waits.
    expect(confirm).not.toHaveBeenCalled()
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('withholds confirmation when the boot threw', () => {
    const confirm = jest.fn()
    // Still "rendered": a render throw unmounts asynchronously and the div can
    // look populated at the instant we ask. The error is the evidence.
    confirmBundleHealthyWhenStable({ confirm, hasRendered: () => true })

    window.dispatchEvent(
      new ErrorEvent('error', {
        message:
          "TypeError: undefined is not an object (evaluating 's?.routes.map')"
      })
    )
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)

    expect(confirm).not.toHaveBeenCalled()
  })

  it('withholds confirmation on an unhandled rejection', () => {
    const confirm = jest.fn()
    confirmBundleHealthyWhenStable({ confirm, hasRendered: () => true })

    window.dispatchEvent(new Event('unhandledrejection'))
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)

    expect(confirm).not.toHaveBeenCalled()
  })

  it('withholds confirmation when nothing is on screen', () => {
    const confirm = jest.fn()
    // The white screen itself: no error need reach us — React can unmount the
    // tree and leave #main empty.
    confirmBundleHealthyWhenStable({ confirm, hasRendered: () => false })

    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)

    expect(confirm).not.toHaveBeenCalled()
  })

  it('stops listening once it has decided, so a later error cannot matter', () => {
    const confirm = jest.fn()
    confirmBundleHealthyWhenStable({ confirm, hasRendered: () => true })
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(confirm).toHaveBeenCalledTimes(1)

    // A crash an hour into a ride is not a reason to un-confirm a bundle that
    // has plainly worked, and there must be no listener left holding the
    // closure alive either.
    window.dispatchEvent(new ErrorEvent('error', { message: 'later' }))
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('reports the verdict it reached, so the sink can show it', () => {
    // 2026-09-02 was diagnosable only because the exact URL could be
    // reconstructed by hand from the PREVIOUS day's log — nothing said whether
    // the health gate had fired, and by then the phone had been force-quit.
    const onVerdict = jest.fn()
    confirmBundleHealthyWhenStable({
      confirm: jest.fn(),
      hasRendered: () => true,
      onVerdict
    })
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(onVerdict).toHaveBeenCalledWith({
      confirmed: true,
      reason: 'confirmed'
    })
  })

  it('names WHICH symptom withheld the confirmation', () => {
    const brokeVerdict = jest.fn()
    confirmBundleHealthyWhenStable({
      confirm: jest.fn(),
      hasRendered: () => true,
      onVerdict: brokeVerdict
    })
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom' }))
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(brokeVerdict).toHaveBeenCalledWith({
      confirmed: false,
      reason: 'boot-error'
    })

    const blankVerdict = jest.fn()
    confirmBundleHealthyWhenStable({
      confirm: jest.fn(),
      hasRendered: () => false,
      onVerdict: blankVerdict
    })
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(blankVerdict).toHaveBeenCalledWith({
      confirmed: false,
      reason: 'not-rendered'
    })
  })

  it('a reporter that throws cannot withhold a healthy confirmation', () => {
    const confirm = jest.fn()
    confirmBundleHealthyWhenStable({
      confirm,
      hasRendered: () => true,
      onVerdict: () => {
        throw new Error('sink unreachable')
      }
    })
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('uses an injected boot reader instead of listening a second time', () => {
    // main.js passes the reader from util/debug-log-boot, armed at the app's
    // very first import — the only thing that sees a throw out of render(),
    // which is where 2026.0902.3 died and which listeners installed on the
    // line AFTER render() can never see.
    const confirm = jest.fn()
    const added = jest.spyOn(window, 'addEventListener')
    let broke = true
    confirmBundleHealthyWhenStable({
      brokeDuringBoot: () => broke,
      confirm,
      hasRendered: () => true
    })
    expect(
      added.mock.calls.filter(
        ([type]) => type === 'error' || type === 'unhandledrejection'
      )
    ).toHaveLength(0)
    added.mockRestore()

    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(confirm).not.toHaveBeenCalled()

    broke = false
    confirmBundleHealthyWhenStable({
      brokeDuringBoot: () => broke,
      confirm,
      hasRendered: () => true
    })
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(confirm).toHaveBeenCalledTimes(1)
  })

  it('reads #main when no renderer check is injected', () => {
    const confirm = jest.fn()
    const main = document.createElement('div')
    main.id = 'main'
    document.body.appendChild(main)

    confirmBundleHealthyWhenStable({ confirm })
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    // Empty #main is a white screen.
    expect(confirm).not.toHaveBeenCalled()

    main.appendChild(document.createElement('span'))
    confirmBundleHealthyWhenStable({ confirm })
    jest.advanceTimersByTime(BUNDLE_HEALTH_GRACE_MS)
    expect(confirm).toHaveBeenCalledTimes(1)

    document.body.removeChild(main)
  })
})

// -------------------------------------------------------------------------
// Applying a queued bundle without waiting for a second launch.
// -------------------------------------------------------------------------
//
// The plugin's own behaviour, read out of @capgo/capacitor-updater 8.51.15 and
// measured on the genuine Play build on 2026-09-02: `autoUpdate: 'onLaunch'`
// applies inside the launch that downloads — but only for the FIRST update
// check of a process. Anything published while the app is already running is
// merely queued (`setNextBundle`), and waits for a background or a relaunch.
// These cases are about that queue: apply it at the first safe moment, and
// never at an unsafe one.
describe('applyPendingBundleWhenSafe', () => {
  // Module state (once-per-boot, the deduped outcome) is per boot by design,
  // so each case gets a fresh module rather than a reset hook.
  function freshModule(): typeof import('../../lib/util/native-updates') {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../lib/util/native-updates')
  }

  const pendingOne = { id: 'ajW1J3Y76Q', version: '2026.0902.4' }
  const idleDeps = (over = {}) => ({
    isHealthConfirmed: () => true,
    isTripActive: () => false,
    pendingBundle: async () => pendingOne,
    runningBundleId: async () => '06NY2QCmaY',
    stashHash: () => undefined,
    ...over
  })

  it('applies a queued bundle when nothing is in flight', async () => {
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()
    const onOutcome = jest.fn()

    expect(
      await applyPendingBundleWhenSafe(idleDeps({ apply, onOutcome }))
    ).toBe('applied')
    expect(apply).toHaveBeenCalledWith('ajW1J3Y76Q')
    expect(onOutcome).toHaveBeenCalledWith('applied', pendingOne)
  })

  it('defers while a Go Mode trip is running, and does not reload', async () => {
    // The whole reason the shell was set to defer in the first place: a bundle
    // swap destroys the JS context, and a rider following turn-by-turn
    // guidance is the one moment this app must not blink.
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()

    expect(
      await applyPendingBundleWhenSafe(
        idleDeps({ apply, isTripActive: () => true })
      )
    ).toBe('deferred: trip-active')
    expect(apply).not.toHaveBeenCalled()
  })

  it('defers while the health gate has not confirmed the running bundle', async () => {
    // Hopping off a bundle that has not proven itself strands the rollback:
    // the plugin reverts to the last bundle that called notifyAppReady.
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()

    expect(
      await applyPendingBundleWhenSafe(
        idleDeps({ apply, isHealthConfirmed: () => false })
      )
    ).toBe('deferred: unconfirmed')
    expect(apply).not.toHaveBeenCalled()
  })

  it('does nothing at all when no bundle is queued', async () => {
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()
    const onOutcome = jest.fn()

    expect(
      await applyPendingBundleWhenSafe(
        idleDeps({ apply, onOutcome, pendingBundle: async () => null })
      )
    ).toBe('none-pending')
    expect(apply).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenCalledWith('none-pending', null)
  })

  it('treats the bundle it is already running as nothing to do', async () => {
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()

    expect(
      await applyPendingBundleWhenSafe(
        idleDeps({ apply, runningBundleId: async () => pendingOne.id })
      )
    ).toBe('none-pending')
    expect(apply).not.toHaveBeenCalled()
  })

  it('refuses a queued bundle the plugin has already marked bad', async () => {
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()

    expect(
      await applyPendingBundleWhenSafe(
        idleDeps({
          apply,
          pendingBundle: async () => ({ ...pendingOne, status: 'error' })
        })
      )
    ).toBe('none-pending')
    expect(apply).not.toHaveBeenCalled()
  })

  it('applies once the trip has ended, on the next look', async () => {
    // The foreground re-check: the rider finished the ride, came back to the
    // app, and the bundle that was deferred mid-trip goes in now.
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()
    let riding = true
    const deps = idleDeps({ apply, isTripActive: () => riding })

    expect(await applyPendingBundleWhenSafe(deps)).toBe('deferred: trip-active')
    expect(apply).not.toHaveBeenCalled()

    riding = false
    expect(await applyPendingBundleWhenSafe(deps)).toBe('applied')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('applies at most once per boot', async () => {
    // Two triggers can arrive together — the plugin's setNext event and a
    // visibilitychange — and a second swap on top of a reload in flight is
    // how a boot loop starts.
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()
    const deps = idleDeps({ apply })

    expect(await applyPendingBundleWhenSafe(deps)).toBe('applied')
    expect(await applyPendingBundleWhenSafe(deps)).toBe('once-per-boot')
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('reports each outcome once, not once per foreground', async () => {
    const { applyPendingBundleWhenSafe } = freshModule()
    const onOutcome = jest.fn()
    const deps = idleDeps({
      apply: jest.fn(),
      isTripActive: () => true,
      onOutcome
    })

    await applyPendingBundleWhenSafe(deps)
    await applyPendingBundleWhenSafe(deps)
    await applyPendingBundleWhenSafe(deps)

    expect(onOutcome).toHaveBeenCalledTimes(1)
  })

  it('stays put, and stays applicable, when the swap is refused', async () => {
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest
      .fn()
      .mockRejectedValueOnce(new Error('no index.html'))
      .mockResolvedValueOnce(undefined)
    const deps = idleDeps({ apply })

    expect(await applyPendingBundleWhenSafe(deps)).toBe('failed')
    // Not burnt: the boot's one apply was never spent on a bundle that
    // refused to load.
    expect(await applyPendingBundleWhenSafe(deps)).toBe('applied')
  })

  it('takes the bundle a setNext event names, without re-reading the queue', async () => {
    // Android emits `updateAvailable` BEFORE it writes the queue
    // (CapgoUpdater.java:908 then :920), so a reader that trusted the queue on
    // an event would be told there is nothing pending. The event's own bundle
    // is the reliable one.
    const { applyPendingBundleWhenSafe } = freshModule()
    const apply = jest.fn()
    const pendingBundle = jest.fn(async () => null)

    expect(
      await applyPendingBundleWhenSafe(
        idleDeps({ apply, candidate: pendingOne, pendingBundle })
      )
    ).toBe('applied')
    expect(pendingBundle).not.toHaveBeenCalled()
    expect(apply).toHaveBeenCalledWith('ajW1J3Y76Q')
  })

  it('parks the URL hash so the reload does not lose the rider', async () => {
    // reload() rebuilds the URL as protocol+host+path
    // (CapacitorUpdaterPlugin.java:2962) — the hash, which is where this app
    // keeps its whole route, is dropped.
    const { applyPendingBundleWhenSafe, restoreHashAfterBundleApply } =
      freshModule()
    window.location.hash = '#/?ui_activeSearch=abc'

    await applyPendingBundleWhenSafe(
      idleDeps({ apply: jest.fn(), stashHash: undefined })
    )
    expect(window.localStorage.getItem('otp.bundleApplyHash')).toContain(
      'ui_activeSearch'
    )

    // The reloaded bundle comes up on the bare app and picks it back up.
    window.location.hash = ''
    restoreHashAfterBundleApply()
    expect(window.location.hash).toBe('#/?ui_activeSearch=abc')
    // Consumed: a hash must never be restored a second time.
    expect(window.localStorage.getItem('otp.bundleApplyHash')).toBeNull()
  })

  it('will not restore a parked hash that outlived its reload', async () => {
    // An old bundle's query re-parsed by new code is exactly the 2026-09-02
    // white screen (backlog 6.46). One reload's worth of grace, never a day.
    const { restoreHashAfterBundleApply } = freshModule()
    window.localStorage.setItem(
      'otp.bundleApplyHash',
      JSON.stringify({ at: Date.now() - 600000, hash: '#/?routeLock=stale' })
    )
    window.location.hash = ''
    restoreHashAfterBundleApply()
    expect(window.location.hash).toBe('')
  })
})

// ---------------------------------------------------------------------------
// The install nobody asked for: the plugin runs `installNext()` on EVERY
// background (CapacitorUpdaterPlugin.java:5302-5303, .swift:4674-4675) with no
// notion of a trip. Measured on the Play build 2026-09-03: a live restored trip
// in the store, the phone pocketed, and `Setting next active bundle` →
// `Reloading:` 14 ms later. The gate above cannot see that happen; only a
// native delay condition can stop it.
// ---------------------------------------------------------------------------
describe('holdBundleWhileTripActive', () => {
  function freshModule(): typeof import('../../lib/util/native-updates') {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../lib/util/native-updates')
  }

  it('arms the one delay kind that survives being backgrounded', async () => {
    const { bundleHoldActive, holdBundleWhileTripActive } = freshModule()
    const setDelay = jest.fn(async () => undefined)
    const onHoldChange = jest.fn()

    expect(await holdBundleWhileTripActive({ onHoldChange, setDelay })).toBe(
      'held'
    )
    // `kill`, and nothing else. checkCancelDelay keeps a kill condition on
    // BACKGROUND and on FOREGROUND and drops it only on KILLED
    // (DelayUpdateUtils.java:89-99, .swift:88-95). A `background` condition is
    // dropped by Android's next foreground WHATEVER its value
    // (DelayUpdateUtils.java:50-88), so the rider's first glance at the app
    // would release the hold mid-ride.
    expect(setDelay).toHaveBeenCalledWith([{ kind: 'kill' }])
    expect(bundleHoldActive()).toBe(true)
    expect(onHoldChange).toHaveBeenCalledWith('bundle_hold', {
      conditions: ['kill']
    })
  })

  it('does not rewrite the hold on every replan', async () => {
    // startGoModeTracking is re-entered by every reroute, every auto-update and
    // the resume; a prefs write per tick is noise, not safety.
    const { holdBundleWhileTripActive } = freshModule()
    const setDelay = jest.fn(async () => undefined)

    await holdBundleWhileTripActive({ setDelay })
    expect(await holdBundleWhileTripActive({ setDelay })).toBe('unchanged')
    expect(setDelay).toHaveBeenCalledTimes(1)
  })

  it('writes once when the boot path and the trip start race', async () => {
    // A resumed trip calls this twice in the same tick — main.js's boot-path
    // hold and the one inside startGoModeTracking. Measured on the Play build
    // 2026-09-03: two `Delay update saved` lines 5 ms apart.
    const { holdBundleWhileTripActive } = freshModule()
    let release: () => void = () => undefined
    const setDelay = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const both = Promise.all([
      holdBundleWhileTripActive({ setDelay }),
      holdBundleWhileTripActive({ setDelay })
    ])
    release()
    expect(await both).toEqual(['held', 'unchanged'])
    expect(setDelay).toHaveBeenCalledTimes(1)
  })

  it('releases the hold when the trip ends', async () => {
    const { bundleHoldActive, holdBundleWhileTripActive } = freshModule()
    const cancel = jest.fn(async () => undefined)
    const onHoldChange = jest.fn()

    await holdBundleWhileTripActive({ setDelay: async () => undefined })
    expect(
      await holdBundleWhileTripActive({ active: false, cancel, onHoldChange })
    ).toBe('released')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(bundleHoldActive()).toBe(false)
    expect(onHoldChange).toHaveBeenCalledWith('bundle_release', {
      conditions: []
    })
  })

  it('is a no-op without a bridge rather than a throw', async () => {
    // A browser, or a store build older than the plugin method. Both must
    // behave exactly as they did before this existed.
    const { bundleHoldActive, holdBundleWhileTripActive } = freshModule()
    expect(await holdBundleWhileTripActive()).toBe('unavailable')
    expect(bundleHoldActive()).toBe(false)
  })
})

describe('applyPendingBundleWhenSafe + the native hold', () => {
  function freshModule(): typeof import('../../lib/util/native-updates') {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../lib/util/native-updates')
  }

  const pendingOne = { id: 'ajW1J3Y76Q', version: '2026.0903.7' }
  const deps = (over = {}) => ({
    apply: jest.fn(),
    holdBundle: jest.fn(async () => undefined),
    isHealthConfirmed: () => true,
    pendingBundle: async () => pendingOne,
    releaseHold: jest.fn(async () => undefined),
    runningBundleId: async () => '06NY2QCmaY',
    stashHash: () => undefined,
    ...over
  })

  it('arms the hold the moment a bundle is queued mid-trip', async () => {
    // `setNext` fires exactly here (watchForPendingBundle), which is the
    // earliest point at which the danger is known to exist at all — before
    // this the queue was empty and there was nothing to hold back.
    const { applyPendingBundleWhenSafe } = freshModule()
    const d = deps({ isTripActive: () => true })

    expect(await applyPendingBundleWhenSafe(d)).toBe('deferred: trip-active')
    expect(d.holdBundle).toHaveBeenCalledTimes(1)
    expect(d.apply).not.toHaveBeenCalled()
    expect(d.releaseHold).not.toHaveBeenCalled()
  })

  it('releases the hold before it applies once the trip is over', async () => {
    // `set()` does not consult the delay list (java:3100), so the swap would
    // otherwise succeed and leave a kill condition behind to block the NEXT
    // bundle for the life of the install.
    const { applyPendingBundleWhenSafe } = freshModule()
    const order: string[] = []
    const d = deps({
      apply: jest.fn(async () => {
        order.push('apply')
      }),
      isTripActive: () => false,
      releaseHold: jest.fn(async () => {
        order.push('release')
      })
    })

    expect(await applyPendingBundleWhenSafe(d)).toBe('applied')
    expect(order).toEqual(['release', 'apply'])
    expect(d.holdBundle).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// The quiet period (backlog 15.6).
//
// Measured on the dev app 2026-09-13, session mu01c0py-nrwza6: bundle
// 2026.0913.2 was queued mid-ride and correctly deferred
// (`bundle_apply {"outcome":"deferred: trip-active"}`, t=1789317571388), and
// then installed 18 ms after the rider tapped Stop to re-run "I'm on the bus"
// — `bundle_release` t=1789317647611, `bundle_apply applied` t=1789317647629,
// with the next onboard flow five seconds later. A trip boundary is not the
// unit; quiet time is.
// ---------------------------------------------------------------------------
describe('the Go Mode quiet period', () => {
  function freshModule(): typeof import('../../lib/util/native-updates') {
    jest.resetModules()
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../lib/util/native-updates')
  }

  /** A hold whose two plugin writes are observable. */
  const holdDeps = () => ({
    cancel: jest.fn(async () => undefined),
    setDelay: jest.fn(async () => undefined)
  })

  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('does not release the hold when a trip stops — it starts a clock', () => {
    const {
      beginGoModeQuietPeriod,
      bundleHoldActive,
      goModeQuietPeriodPending,
      noteGoModeActivity
    } = freshModule()
    const d = holdDeps()

    noteGoModeActivity(d)
    expect(bundleHoldActive()).toBe(true)

    beginGoModeQuietPeriod({ ...d, onQuiet: jest.fn() })
    // The 11:40:47 moment: nothing may come off here.
    expect(d.cancel).not.toHaveBeenCalled()
    expect(bundleHoldActive()).toBe(true)
    expect(goModeQuietPeriodPending()).toBe(true)
  })

  it('refreshes the clock on every further stop rather than releasing', () => {
    // The rider stopped four times in three minutes on 2026-09-13. Each stop
    // must buy another full period, not bring the deadline closer.
    const { beginGoModeQuietPeriod, bundleHoldActive, noteGoModeActivity } =
      freshModule()
    const d = holdDeps()
    const onQuiet = jest.fn()
    const quietMs = 600000

    noteGoModeActivity(d)
    beginGoModeQuietPeriod({ ...d, onQuiet, quietMs })
    jest.advanceTimersByTime(quietMs - 1000)
    beginGoModeQuietPeriod({ ...d, onQuiet, quietMs })
    jest.advanceTimersByTime(quietMs - 1000)

    // Nearly twice the period has elapsed in wall time, and the hold stands.
    expect(onQuiet).not.toHaveBeenCalled()
    expect(d.cancel).not.toHaveBeenCalled()
    expect(bundleHoldActive()).toBe(true)
  })

  it('releases and applies once the period elapses with nothing running', () => {
    // The session that never starts another trip still has to get the bundle:
    // the timer is the only thing that can deliver it without a relaunch.
    const {
      beginGoModeQuietPeriod,
      bundleHoldActive,
      GO_MODE_QUIET_PERIOD_MS,
      goModeQuietPeriodPending,
      noteGoModeActivity
    } = freshModule()
    const d = holdDeps()
    const onQuiet = jest.fn()

    noteGoModeActivity(d)
    beginGoModeQuietPeriod({ ...d, onQuiet })

    jest.advanceTimersByTime(GO_MODE_QUIET_PERIOD_MS - 1)
    expect(onQuiet).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(d.cancel).toHaveBeenCalledTimes(1)
    expect(onQuiet).toHaveBeenCalledTimes(1)
    expect(bundleHoldActive()).toBe(false)
    expect(goModeQuietPeriodPending()).toBe(false)
  })

  it('ten minutes, so a transfer wait cannot be mistaken for being done', () => {
    const { GO_MODE_QUIET_PERIOD_MS } = freshModule()
    expect(GO_MODE_QUIET_PERIOD_MS).toBe(600000)
  })

  it('cancels the clock when Go Mode starts again', () => {
    // The onboard flow five seconds after the Stop. This is the case the trip
    // boundary got wrong.
    const {
      beginGoModeQuietPeriod,
      bundleHoldActive,
      GO_MODE_QUIET_PERIOD_MS,
      goModeQuietPeriodPending,
      noteGoModeActivity
    } = freshModule()
    const d = holdDeps()
    const onQuiet = jest.fn()

    noteGoModeActivity(d)
    beginGoModeQuietPeriod({ ...d, onQuiet })
    jest.advanceTimersByTime(5000)
    noteGoModeActivity(d)

    expect(goModeQuietPeriodPending()).toBe(false)
    jest.advanceTimersByTime(GO_MODE_QUIET_PERIOD_MS * 2)
    expect(onQuiet).not.toHaveBeenCalled()
    expect(d.cancel).not.toHaveBeenCalled()
    expect(bundleHoldActive()).toBe(true)
  })

  it('waits another period when the timer finds a trip running', () => {
    // A trip restored by a path that does not call noteGoModeActivity. Quiet
    // means quiet: wait again rather than swap the bundle under it.
    const { beginGoModeQuietPeriod, GO_MODE_QUIET_PERIOD_MS } = freshModule()
    const d = holdDeps()
    const onQuiet = jest.fn()
    let active = true

    beginGoModeQuietPeriod({ ...d, isTripActive: () => active, onQuiet })
    jest.advanceTimersByTime(GO_MODE_QUIET_PERIOD_MS)
    expect(onQuiet).not.toHaveBeenCalled()

    active = false
    jest.advanceTimersByTime(GO_MODE_QUIET_PERIOD_MS)
    expect(onQuiet).toHaveBeenCalledTimes(1)
  })

  it('keeps the apply across a refresh that does not carry one', () => {
    // One STOP starts the same quiet period twice — endGoMode and main.js's
    // store subscription — and only the second knows how to apply a bundle.
    // Whichever lands last, the apply must survive.
    const { beginGoModeQuietPeriod, GO_MODE_QUIET_PERIOD_MS } = freshModule()
    const d = holdDeps()
    const onQuiet = jest.fn()

    beginGoModeQuietPeriod({ ...d, onQuiet })
    beginGoModeQuietPeriod(d)
    jest.advanceTimersByTime(GO_MODE_QUIET_PERIOD_MS)

    expect(onQuiet).toHaveBeenCalledTimes(1)
  })

  it('defers a queued bundle for the whole quiet period', async () => {
    const {
      applyPendingBundleWhenSafe,
      beginGoModeQuietPeriod,
      GO_MODE_QUIET_PERIOD_MS,
      noteGoModeActivity
    } = freshModule()
    const d = holdDeps()
    const pending = { id: 'ajW1J3Y76Q', version: '2026.0913.2' }
    const gate = {
      apply: jest.fn(),
      holdBundle: jest.fn(async () => undefined),
      isHealthConfirmed: () => true,
      isTripActive: () => false,
      pendingBundle: async () => pending,
      releaseHold: jest.fn(async () => undefined),
      runningBundleId: async () => '06NY2QCmaY',
      stashHash: () => undefined
    }

    noteGoModeActivity(d)
    beginGoModeQuietPeriod({ ...d, onQuiet: () => undefined })

    // main.js's store subscription, and every foreground after it.
    expect(await applyPendingBundleWhenSafe(gate)).toBe(
      'deferred: quiet-period'
    )
    expect(gate.apply).not.toHaveBeenCalled()
    // Held on the native side too: the plugin would otherwise install it at
    // the next background all by itself.
    expect(gate.holdBundle).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(GO_MODE_QUIET_PERIOD_MS)
    expect(await applyPendingBundleWhenSafe(gate)).toBe('applied')
    expect(gate.apply).toHaveBeenCalledWith('ajW1J3Y76Q')
  })

  it('ends the quiet period when the rider backgrounds the app', () => {
    // The one install moment the plugin has always owned: get out of its way
    // rather than reloading a webview the OS is suspending.
    const {
      beginGoModeQuietPeriod,
      bundleHoldActive,
      endGoModeQuietPeriodOnBackground,
      goModeQuietPeriodPending,
      noteGoModeActivity
    } = freshModule()
    const d = holdDeps()
    const onQuiet = jest.fn()

    noteGoModeActivity(d)
    beginGoModeQuietPeriod({ ...d, onQuiet })
    endGoModeQuietPeriodOnBackground(d)

    expect(d.cancel).toHaveBeenCalledTimes(1)
    expect(bundleHoldActive()).toBe(false)
    expect(goModeQuietPeriodPending()).toBe(false)
    // No apply from here: `set()` reloads, and the app is on its way out.
    expect(onQuiet).not.toHaveBeenCalled()
  })

  it('never releases on a background while a trip is running', () => {
    // A rider following turn-by-turn with the screen locked backgrounds the
    // app constantly. That is the case the hold exists for.
    const {
      beginGoModeQuietPeriod,
      bundleHoldActive,
      endGoModeQuietPeriodOnBackground,
      noteGoModeActivity
    } = freshModule()
    const d = holdDeps()

    noteGoModeActivity(d)
    beginGoModeQuietPeriod({ ...d, isTripActive: () => true })
    endGoModeQuietPeriodOnBackground({ ...d, isTripActive: () => true })

    expect(d.cancel).not.toHaveBeenCalled()
    expect(bundleHoldActive()).toBe(true)
  })

  it('is inert on a background with no quiet period pending', () => {
    // A cold launch has neither hold nor timer (the plugin drops the kill
    // condition in its own load()), and this must not invent work for it.
    const { endGoModeQuietPeriodOnBackground } = freshModule()
    const d = holdDeps()
    endGoModeQuietPeriodOnBackground(d)
    expect(d.cancel).not.toHaveBeenCalled()
  })
})
