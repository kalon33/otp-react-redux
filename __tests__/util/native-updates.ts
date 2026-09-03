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
