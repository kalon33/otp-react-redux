import {
  getNativeLaunches,
  NATIVE_LAUNCH_HISTORY,
  recordNativeLaunch
} from '../../lib/util/native-updates'

// Backlog 44.1: the dev app keeps coming back as a "fresh install" (new Capgo
// Keychain id, new web id, built-in bundle). The native shell's LaunchProbe
// records how each process was launched; this is the web half that sends ONE
// NATIVE_LAUNCH record at boot. It must be harmless wherever the plugin is
// missing — a browser, or a native shell built before the probe — because the
// web bundle ships to phones ahead of the native build.

const PRE_UNLOCK_LAUNCH = {
  activePrewarm: null,
  applicationState: 'background',
  defaultsKeyCount: 0,
  firstInContainer: false,
  isProtectedDataAvailable: false,
  keychainAttrStatus: -25308,
  keychainDataStatus: -25308,
  launchId: 'b',
  launchOptionKeys: ['UIApplicationLaunchOptionsLocationKey'],
  nativeVersion: '0.0.37',
  systemUptime: 41.2,
  t: 1792500000000
}

function setCapacitor(value: unknown) {
  Object.assign(window, { Capacitor: value })
}

afterEach(() => {
  delete (window as any).Capacitor
})

describe('getNativeLaunches / recordNativeLaunch', () => {
  it('sends nothing in a browser (no Capacitor)', async () => {
    const send = jest.fn()
    await expect(getNativeLaunches()).resolves.toBeNull()
    await expect(recordNativeLaunch(send)).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends nothing on a native shell built before LaunchProbe', async () => {
    const send = jest.fn()
    // An older shell: the bridge is there, the plugin is not registered.
    setCapacitor({
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'CapacitorUpdater',
      Plugins: { CapacitorUpdater: { current: jest.fn() } }
    })
    await expect(recordNativeLaunch(send)).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()

    // And a bridge with no isPluginAvailable and no such plugin at all.
    setCapacitor({ isNativePlatform: () => true, Plugins: {} })
    await expect(recordNativeLaunch(send)).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends nothing, and does not throw, when the plugin call rejects', async () => {
    const send = jest.fn()
    setCapacitor({
      isNativePlatform: () => true,
      isPluginAvailable: () => true,
      Plugins: {
        LaunchProbe: {
          getLaunches: jest.fn().mockRejectedValue(new Error('not implemented'))
        }
      }
    })
    await expect(recordNativeLaunch(send)).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends one NATIVE_LAUNCH record carrying the probe when the plugin is there', async () => {
    const send = jest.fn()
    const getLaunches = jest.fn().mockResolvedValue({
      launches: [{ launchId: 'a' }, PRE_UNLOCK_LAUNCH],
      now: { isProtectedDataAvailable: true, keychainDataStatus: 0 }
    })
    setCapacitor({
      isNativePlatform: () => true,
      isPluginAvailable: (name: string) => name === 'LaunchProbe',
      Plugins: { LaunchProbe: { getLaunches } }
    })

    await expect(recordNativeLaunch(send)).resolves.toBe(true)

    expect(getLaunches).toHaveBeenCalledWith({ limit: NATIVE_LAUNCH_HISTORY })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('NATIVE_LAUNCH', {
      launches: [{ launchId: 'a' }, PRE_UNLOCK_LAUNCH],
      now: { isProtectedDataAvailable: true, keychainDataStatus: 0 },
      writeError: undefined
    })
  })

  it('ignores a malformed plugin answer', async () => {
    const send = jest.fn()
    setCapacitor({
      isNativePlatform: () => true,
      Plugins: {
        LaunchProbe: { getLaunches: jest.fn().mockResolvedValue({}) }
      }
    })
    await expect(recordNativeLaunch(send)).resolves.toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('a throwing sender never escapes into the boot', async () => {
    const send = jest.fn(() => {
      throw new Error('beacon blew up')
    })
    await expect(
      recordNativeLaunch(send, async () => ({ launches: [PRE_UNLOCK_LAUNCH] }))
    ).resolves.toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
