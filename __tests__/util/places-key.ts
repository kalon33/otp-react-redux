import { getPlacesKey } from '../../lib/util/places-key'

const g = window as any
const KEY = 'Ab3_dEf-GhIjKlMnOpQrStUvWxYz0123456789abcde' // 43 base64url chars

/** A native shell whose AppKeys plugin answers with `impl`. */
function shell(
  impl?: () => Promise<any>,
  { available = true, native = true } = {}
) {
  g.Capacitor = {
    isNativePlatform: () => native,
    isPluginAvailable: (name: string) => available && name === 'AppKeys',
    Plugins: impl ? { AppKeys: { getPlacesKey: jest.fn(impl) } } : {}
  }
}

describe('lib > util > places-key (backlog 60.1)', () => {
  afterEach(() => {
    delete g.Capacitor
  })

  it('returns the installed app key when the AppKeys plugin has one', async () => {
    shell(() => Promise.resolve({ key: KEY }))
    expect(await getPlacesKey()).toBe(KEY)
    expect(g.Capacitor.Plugins.AppKeys.getPlacesKey).toHaveBeenCalledTimes(1)
  })

  it('is null in a plain browser (no bridge at all)', async () => {
    expect(await getPlacesKey()).toBeNull()
  })

  it('is null on the web platform even when a proxy exists', async () => {
    shell(() => Promise.resolve({ key: KEY }), { native: false })
    expect(await getPlacesKey()).toBeNull()
    expect(g.Capacitor.Plugins.AppKeys.getPlacesKey).not.toHaveBeenCalled()
  })

  it('is null in a shell built before AppKeys (plugin not available natively)', async () => {
    shell(() => Promise.resolve({ key: KEY }), { available: false })
    expect(await getPlacesKey()).toBeNull()
    expect(g.Capacitor.Plugins.AppKeys.getPlacesKey).not.toHaveBeenCalled()
  })

  it('is null when the plugin object is missing', async () => {
    shell(undefined)
    expect(await getPlacesKey()).toBeNull()
  })

  it('is null when the plugin rejects', async () => {
    shell(() => Promise.reject(new Error('UNIMPLEMENTED')))
    expect(await getPlacesKey()).toBeNull()
  })

  it('is null when the build carried no key', async () => {
    shell(() => Promise.resolve({ key: null }))
    expect(await getPlacesKey()).toBeNull()
    shell(() => Promise.resolve({}))
    expect(await getPlacesKey()).toBeNull()
    shell(() => Promise.resolve(null))
    expect(await getPlacesKey()).toBeNull()
  })

  it('rejects a key of the wrong shape (the server would refuse it)', async () => {
    for (const bad of [
      '',
      'short',
      'has space in it here',
      'slash/is/not/base64url',
      'x'.repeat(65),
      '$(TNPlacesKey)',
      42
    ]) {
      shell(() => Promise.resolve({ key: bad }))
      expect(await getPlacesKey()).toBeNull()
    }
  })
})
