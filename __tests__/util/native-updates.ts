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
