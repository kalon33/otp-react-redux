/**
 * Backlog 8.8(b). WKWebView refuses the web Screen Wake Lock API outright —
 * `NotAllowedError: "Permission was denied"`, four times on the 2026-09-04
 * ride (`~/otp-debug-logs/debug-2026-09-04.jsonl`, session `mtn4ui3s-xfjx8m`,
 * 10:59:36/41 and 11:05:11/16) on bundle 2026.0904.2, which already carried
 * 4.16's retry ladder. The fix is native, and the whole risk of shipping it as
 * an OTA is the selection this file pins: a shell WITH the plugin must use it
 * and must not run the web ladder at all, and a shell WITHOUT it must behave
 * exactly as it does today.
 */

import { act } from 'react-dom/test-utils'
import React from 'react'
import ReactDOM from 'react-dom'

import useActiveTripGuards from '../../../lib/components/go-mode/use-active-trip-guards'

describe('keep awake: native plugin vs the web ladder (2026-09-04)', () => {
  let container: HTMLDivElement

  const Harness = () => {
    useActiveTripGuards(true)
    return null
  }

  beforeEach(() => {
    jest.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    })
  })

  afterEach(() => {
    act(() => {
      ReactDOM.unmountComponentAtNode(container)
    })
    container.remove()
    delete (navigator as any).wakeLock
    delete (window as any).Capacitor
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  /** The shell's injected bridge, as native-notify.ts and native-gps.ts see it. */
  const installShell = (opts: {
    allowSleep?: jest.Mock
    keepAwake?: jest.Mock
    /** false = a shell built before the plugin landed. */
    pluginAvailable?: boolean
    /** older bridges expose no isPluginAvailable at all */
    withIsPluginAvailable?: boolean
  }) => {
    const keepAwake = opts.keepAwake ?? jest.fn(() => Promise.resolve())
    const allowSleep = opts.allowSleep ?? jest.fn(() => Promise.resolve())
    const available = opts.pluginAvailable !== false
    const cap: any = {
      isNativePlatform: () => true,
      Plugins: available ? { KeepAwake: { allowSleep, keepAwake } } : {}
    }
    if (opts.withIsPluginAvailable !== false) {
      cap.isPluginAvailable = (name: string) =>
        name === 'KeepAwake' && available
    }
    const win = window as any
    win.Capacitor = cap
    return { allowSleep, keepAwake }
  }

  const installWebWakeLock = () => {
    const request = jest.fn(() => {
      const err: any = new Error('Permission was denied')
      err.name = 'NotAllowedError'
      return Promise.reject(err)
    })
    const nav = navigator as any
    nav.wakeLock = { request }
    return request
  }

  const flushMicrotasks = async () => {
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  const mount = async () => {
    await act(async () => {
      ReactDOM.render(React.createElement(Harness), container)
    })
    await flushMicrotasks()
  }

  it('uses the plugin, and never touches the web API, when the shell has it', async () => {
    const { keepAwake } = installShell({})
    const request = installWebWakeLock()

    await mount()

    expect(keepAwake).toHaveBeenCalledTimes(1)
    // The point of the whole change: the ladder that could only ever produce
    // four more NotAllowedErrors is not entered.
    expect(request).not.toHaveBeenCalled()
    await act(async () => {
      jest.advanceTimersByTime(30000)
    })
    await flushMicrotasks()
    expect(request).not.toHaveBeenCalled()
  })

  it('lets the screen sleep again when the trip ends', async () => {
    const { allowSleep } = installShell({})
    installWebWakeLock()

    await mount()
    expect(allowSleep).not.toHaveBeenCalled()

    await act(async () => {
      ReactDOM.unmountComponentAtNode(container)
    })
    await flushMicrotasks()
    expect(allowSleep).toHaveBeenCalledTimes(1)
  })

  it('drops the override while the app is off screen and retakes it on return', async () => {
    const { allowSleep, keepAwake } = installShell({})
    installWebWakeLock()
    await mount()
    expect(keepAwake).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden'
    })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flushMicrotasks()
    expect(allowSleep).toHaveBeenCalledTimes(1)
    expect(keepAwake).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible'
    })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flushMicrotasks()
    expect(keepAwake).toHaveBeenCalledTimes(2)
  })

  it('falls back to the web ladder on a shell built before the plugin', async () => {
    /**
     * This is the OTA-safety case. A bundle carrying this hook is served to a
     * shell whose native side has no KeepAwake: `isPluginAvailable` says false,
     * and the behaviour must be byte-for-byte what shipped on 2026-09-04 —
     * the web request, then the ladder.
     */
    const { keepAwake } = installShell({ pluginAvailable: false })
    const request = installWebWakeLock()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await mount()

    expect(keepAwake).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)
    await act(async () => {
      jest.advanceTimersByTime(5000)
    })
    await flushMicrotasks()
    expect(request).toHaveBeenCalledTimes(2)
    ;(console.warn as jest.Mock).mockRestore()
  })

  it('falls back in a plain browser, where there is no bridge at all', async () => {
    const request = installWebWakeLock()
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await mount()

    expect(request).toHaveBeenCalledTimes(1)
    ;(console.warn as jest.Mock).mockRestore()
  })

  it('a plugin that throws is reported, not propagated, and does not fall back', async () => {
    /**
     * Never throws: this runs in an effect guarding a live trip. And it does
     * NOT then run the web ladder — inside the shell that ladder is four more
     * NotAllowedErrors, which is the noise 4.16 already proved useless.
     * The warn keeps ride-watch's `wake-lock-denied` prefix so a native
     * refusal cannot go unseen the way the web one did.
     */
    const keepAwake = jest.fn(() => Promise.reject(new Error('nope')))
    installShell({ keepAwake })
    const request = installWebWakeLock()
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await mount()

    expect(keepAwake).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('Wake lock request failed')
    warn.mockRestore()
  })

  it('uses the Plugins registry when the bridge predates isPluginAvailable', async () => {
    const { keepAwake } = installShell({ withIsPluginAvailable: false })
    const request = installWebWakeLock()

    await mount()

    expect(keepAwake).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })
})
