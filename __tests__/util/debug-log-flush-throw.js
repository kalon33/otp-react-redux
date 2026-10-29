/**
 * 75.38: a throw in selectBatch/buildBatch must not wedge the flush.
 *
 * debug-log.js cannot be imported by Jest (import.meta), so this compiles a
 * copy of its source with import.meta neutralised and loads it with its
 * sibling modules mocked, then drives the real interval flush.
 */
import fs from 'fs'
import path from 'path'

import { transformSync } from '@babel/core'

const SRC = path.join(__dirname, '../../lib/util/debug-log.js')

function loadDebugLog(deps) {
  const code = transformSync(
    fs.readFileSync(SRC, 'utf8').replace(/import\.meta/g, '({})'),
    {
      babelrc: false,
      configFile: false,
      filename: SRC,
      plugins: ['@babel/plugin-transform-modules-commonjs']
    }
  ).code
  const mod = { exports: {} }
  const req = (id) => {
    if (id in deps) return deps[id]
    return require(path.resolve(path.dirname(SRC), id))
  }
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports)
  return mod.exports
}

describe('util > debug-log flush (75.38)', () => {
  let fetchMock
  beforeEach(() => {
    jest.useFakeTimers()
    fetchMock = jest.fn(() => Promise.resolve({}))
    global.fetch = fetchMock
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  function boot(selectBatch) {
    return loadDebugLog({
      './debug-log-batch': { selectBatch },
      './debug-log-boot': {
        applyDebugLogUrlOverride: jest.fn(),
        bootSessionId: () => 'sess',
        getDeviceId: () => 'dev',
        isDiagnosticsEnabled: () => true,
        mintBootEntryId: () => `id-${Math.random()}`,
        setBootSessionId: jest.fn()
      }
    })
  }

  it('keeps flushing after buildBatch/selectBatch throws once', () => {
    const selectBatch = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('selectBatch blew up')
      })
      .mockImplementation((buf) => buf.slice())
    const log = boot(selectBatch)
    log.startDebugLog()
    // First interval tick: the throw. It must not escape the timer...
    expect(() => jest.advanceTimersByTime(3000)).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    // ...nor hold the next flush off for the 30 s in-flight window.
    jest.advanceTimersByTime(3000)
    expect(selectBatch).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
