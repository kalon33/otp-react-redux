/**
 * Backlog 8.17. The first trip on Android loses its notifications: trip start
 * fires `ensureNativeNotifyPermission()` fire-and-forget
 * (`lib/actions/go-mode.ts:3747`), and on Android 13+ `POST_NOTIFICATIONS` is a
 * runtime permission denied by default, so the system dialog is still up when
 * the first GPS tick schedules cards. Measured on the emulator trip of
 * 2026-09-04 (`~/otp-debug-logs/debug-2026-09-04.jsonl`, session
 * `mtnf29ie-jlv2sk`): three `LocalNotifications.schedule` calls at
 * 15:41:34.136–.137 each answered `{"error":{"message":"Notifications not
 * enabled on this device"}}` — one of them the pacing/board card, id 2,
 * "🚲 6 min ride · 1 min wait" — the grant landed at 15:42:02.911, and the next
 * schedule at 15:42:09.207 worked. Twenty-eight seconds of alerts, gone.
 *
 * What this file pins is the gate and its three exits: held while the dialog is
 * up, replayed (newest per key) on Allow, dropped with ONE warn on Deny — and,
 * the part that must not regress, a device that has already granted keeps
 * scheduling straight through with nothing added in front of it. iOS is that
 * last case: it settles the permission at first launch, so it never queues.
 */

import {
  __resetNativeNotifyPermission,
  cancelPush,
  ensureNativeNotifyPermission,
  sendPush
} from '../../../lib/util/go-mode/native-notify'

/** The pacing/board card's stable id — the one the emulator trip lost. */
const PACING_ID = 2

describe('native notify: permission gate (backlog 8.17)', () => {
  let schedule: jest.Mock
  let cancel: jest.Mock
  let checkPermissions: jest.Mock
  let requestPermissions: jest.Mock
  let warn: jest.SpyInstance

  /** The shell's injected bridge, exactly as native-notify.ts reads it. */
  const installShell = () => {
    const w = window as any
    w.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        LocalNotifications: {
          cancel,
          checkPermissions,
          requestPermissions,
          schedule
        }
      }
    }
  }

  /**
   * Drain the microtask queue. Async/await here is transpiled to generators,
   * so a single `await Promise.resolve()` is not enough to walk
   * `ensureNativeNotifyPermission` past its `checkPermissions` await and into
   * the pending state.
   */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  const cardTitles = () =>
    schedule.mock.calls.map((c) => c[0].notifications[0].title)

  beforeEach(() => {
    __resetNativeNotifyPermission()
    schedule = jest.fn(() => Promise.resolve())
    cancel = jest.fn(() => Promise.resolve())
    checkPermissions = jest.fn(() => Promise.resolve({ display: 'granted' }))
    requestPermissions = jest.fn(() => Promise.resolve({ display: 'granted' }))
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warn.mockRestore()
    delete (window as any).Capacitor
    __resetNativeNotifyPermission()
  })

  it('holds cards raised while the dialog is up, then replays the latest of each key', async () => {
    // The dialog stays up until the test lets it go, the way the rider's 28 s
    // of reading did on the emulator.
    let allow: (r: { display: string }) => void = () => undefined
    requestPermissions.mockImplementation(
      () => new Promise((resolve) => (allow = resolve))
    )
    checkPermissions.mockResolvedValue({ display: 'prompt' })
    installShell()

    const asking = ensureNativeNotifyPermission()
    // Let checkPermissions resolve so the gate is actually open.
    await flush()

    await sendPush({ id: PACING_ID, message: 'a', title: '🚲 8 min ride' })
    await sendPush({ id: PACING_ID, message: 'b', title: '🚲 7 min ride' })
    await sendPush({
      id: PACING_ID,
      message: 'c',
      title: '🚲 6 min ride · 1 min wait'
    })

    // The bug, negated: nothing reaches the plugin while the dialog is up, so
    // nothing can come back "Notifications not enabled on this device".
    expect(schedule).not.toHaveBeenCalled()

    allow({ display: 'granted' })
    await asking

    expect(schedule).toHaveBeenCalledTimes(1)
    expect(cardTitles()).toEqual(['🚲 6 min ride · 1 min wait'])
    expect(schedule.mock.calls[0][0].notifications[0].id).toBe(PACING_ID)
    expect(warn).not.toHaveBeenCalled()
  })

  it('replays one card per key, newest last, when several keys are held', async () => {
    let allow: (r: { display: string }) => void = () => undefined
    requestPermissions.mockImplementation(
      () => new Promise((resolve) => (allow = resolve))
    )
    checkPermissions.mockResolvedValue({ display: 'prompt' })
    installShell()

    const asking = ensureNativeNotifyPermission()
    await flush()

    await sendPush({ id: 1, message: 'turn', title: 'Turn left' })
    await sendPush({ id: PACING_ID, message: 'pace', title: '🚲 8 min ride' })
    await sendPush({ id: 1, message: 'turn2', title: 'Turn right' })

    allow({ display: 'granted' })
    await asking

    // Two keys survive, and the re-raised turn card moved to the back so the
    // freshest thing the rider needs is the one on top of the stack.
    expect(cardTitles()).toEqual(['🚲 8 min ride', 'Turn right'])
  })

  it('drops held cards on refusal, with exactly one warn and no schedule', async () => {
    checkPermissions.mockResolvedValue({ display: 'prompt' })
    requestPermissions.mockResolvedValue({ display: 'denied' })
    installShell()

    expect(await ensureNativeNotifyPermission()).toBe(false)

    await sendPush({ id: PACING_ID, message: 'a', title: 'Board 539' })
    await sendPush({ id: PACING_ID, message: 'b', title: 'Board 539' })
    await sendPush({ message: 'c', title: 'Arriving' })

    expect(schedule).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('Notification permission denied')

    // A second trip re-asks and is refused again: still one warn in the log,
    // not one per trip and certainly not one per card.
    await ensureNativeNotifyPermission()
    await sendPush({ id: PACING_ID, message: 'd', title: 'Board 539' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(schedule).not.toHaveBeenCalled()
  })

  it('schedules immediately on a device that already granted (iOS, and Android after the first trip)', async () => {
    checkPermissions.mockResolvedValue({ display: 'granted' })
    installShell()

    expect(await ensureNativeNotifyPermission()).toBe(true)
    // The prompt is never raised, so nothing is ever held.
    expect(requestPermissions).not.toHaveBeenCalled()

    await sendPush({ id: PACING_ID, message: 'a', title: 'Board 539' })
    await sendPush({ id: 1, message: 'b', title: 'Turn left' })
    await sendPush({ message: 'c', title: 'Arriving' })

    expect(schedule).toHaveBeenCalledTimes(3)
    expect(cardTitles()).toEqual(['Board 539', 'Turn left', 'Arriving'])
  })

  it('schedules straight through before anyone has asked — the gate adds nothing to the old path', async () => {
    installShell()
    await sendPush({ id: PACING_ID, message: 'a', title: 'Board 539' })
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(checkPermissions).not.toHaveBeenCalled()
  })

  it('bounds the hold queue and keeps the newest keys', async () => {
    let allow: (r: { display: string }) => void = () => undefined
    requestPermissions.mockImplementation(
      () => new Promise((resolve) => (allow = resolve))
    )
    checkPermissions.mockResolvedValue({ display: 'prompt' })
    installShell()

    const asking = ensureNativeNotifyPermission()
    await flush()

    // A rider who leaves the dialog sitting for a whole leg.
    for (let i = 0; i < 20; i++) {
      await sendPush({ id: 100 + i, message: `m${i}`, title: `t${i}` })
    }
    expect(schedule).not.toHaveBeenCalled()

    allow({ display: 'granted' })
    await asking

    // 20 distinct keys went in; at most 8 come out, and they are the last 8.
    expect(schedule).toHaveBeenCalledTimes(8)
    expect(cardTitles()).toEqual([
      't12',
      't13',
      't14',
      't15',
      't16',
      't17',
      't18',
      't19'
    ])
  })

  it('never queues, warns or schedules in a plain browser', async () => {
    await sendPush({ id: PACING_ID, message: 'a', title: 'Board 539' })
    expect(await ensureNativeNotifyPermission()).toBe(false)
    expect(schedule).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('drops a held card that is cancelled before the rider answers', async () => {
    let allow: (r: { display: string }) => void = () => undefined
    requestPermissions.mockImplementation(
      () => new Promise((resolve) => (allow = resolve))
    )
    checkPermissions.mockResolvedValue({ display: 'prompt' })
    installShell()

    const asking = ensureNativeNotifyPermission()
    await flush()

    await sendPush({ id: 1, message: 'turn', title: 'Turn left' })
    await sendPush({ id: PACING_ID, message: 'pace', title: '🚲 8 min ride' })
    // The rider took the turn while the dialog was still up.
    await cancelPush(1)
    expect(cancel).not.toHaveBeenCalled()

    allow({ display: 'granted' })
    await asking

    expect(cardTitles()).toEqual(['🚲 8 min ride'])
  })
})
