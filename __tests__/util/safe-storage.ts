import coreUtils from '@opentripplanner/core-utils'

import {
  getItem,
  isPersisted,
  readRaw,
  removeItem,
  resetSafeStorageForTests,
  setStorageFailureReporter,
  storeItem,
  writeRaw
} from '../../lib/util/safe-storage'

/**
 * Backlog 75.12: the one helper every localStorage write goes through. A
 * refused write (QuotaExceededError, SecurityError) never throws, keeps the
 * value in memory for the session, and is reported once.
 */

const quotaExceeded = () => {
  throw new DOMException(
    "Failed to execute 'setItem' on 'Storage': Setting the value of 'otp.recent' exceeded the quota.",
    'QuotaExceededError'
  )
}

describe('util > safe-storage (75.12)', () => {
  let setItem: jest.SpyInstance | null = null

  beforeEach(() => {
    window.localStorage.clear()
    resetSafeStorageForTests()
  })

  afterEach(() => {
    setItem?.mockRestore()
    setItem = null
    window.localStorage.clear()
    resetSafeStorageForTests()
  })

  const fillStorage = () => {
    setItem = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(quotaExceeded)
  }

  it('writes exactly what coreUtils.storage writes, and reads what it wrote', () => {
    expect(storeItem('recent', [{ lat: 1, lon: 2 }])).toBe(true)
    expect(window.localStorage.getItem('otp.recent')).toBe(
      JSON.stringify([{ lat: 1, lon: 2 }])
    )
    expect(coreUtils.storage.getItem('recent')).toEqual([{ lat: 1, lon: 2 }])
    coreUtils.storage.storeItem('home', { name: 'Home' })
    expect(getItem('home')).toEqual({ name: 'Home' })
  })

  it("keeps getItem's contract: falsy and unreadable values are not found", () => {
    storeItem('trackRecent', false)
    expect(getItem('trackRecent', 'nf')).toBe('nf')
    window.localStorage.setItem('otp.broken', '{not json')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => null)
    expect(getItem('broken', [])).toEqual([])
    warn.mockRestore()
    expect(getItem('absent', null)).toBeNull()
  })

  it('a refused write does not throw, reports false, and is read back from memory', () => {
    fillStorage()
    let ok: boolean | undefined
    expect(() => {
      ok = storeItem('recent', [{ lat: 44.9778, lon: -93.2707 }])
    }).not.toThrow()
    expect(ok).toBe(false)
    expect(getItem('recent')).toEqual([{ lat: 44.9778, lon: -93.2707 }])
    expect(isPersisted('recent')).toBe(false)
  })

  it('a later write that reaches storage replaces the memory copy', () => {
    fillStorage()
    storeItem('recent', ['held'])
    setItem?.mockRestore()
    setItem = null
    expect(storeItem('recent', ['kept'])).toBe(true)
    expect(getItem('recent')).toEqual(['kept'])
    expect(window.localStorage.getItem('otp.recent')).toBe('["kept"]')
  })

  it('removeItem drops the memory copy too', () => {
    fillStorage()
    storeItem('recent', ['held'])
    removeItem('recent')
    expect(getItem('recent', 'gone')).toBe('gone')
  })

  it('raw keys get the same treatment', () => {
    fillStorage()
    expect(writeRaw('otpDebugLog', '1')).toBe(false)
    expect(readRaw('otpDebugLog')).toBe('1')
  })

  it('reports the first refusal once, with the key and the error name', () => {
    const reports: unknown[] = []
    setStorageFailureReporter((f) => reports.push(f))
    fillStorage()
    storeItem('recent', ['a'])
    storeItem('goModeSession', { big: 'x'.repeat(10) })
    writeRaw('lang', 'en-US')
    expect(reports).toEqual([
      { chars: 5, error: 'QuotaExceededError', key: 'otp.recent' }
    ])
  })

  it('a refusal before the reporter exists is delivered when it registers', () => {
    fillStorage()
    storeItem('recent', ['a'])
    const reports: unknown[] = []
    setStorageFailureReporter((f) => reports.push(f))
    storeItem('recent', ['b'])
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ key: 'otp.recent' })
  })

  it('storage that cannot even be reached (SecurityError) degrades the same way', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
    })
    try {
      const reports: any[] = []
      setStorageFailureReporter((f) => reports.push(f))
      expect(storeItem('theme', 'dark')).toBe(false)
      expect(getItem('theme')).toBe('dark')
      expect(() => removeItem('theme')).not.toThrow()
      expect(reports).toEqual([
        { chars: 6, error: 'SecurityError', key: 'otp.theme' }
      ])
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
      else delete (window as any).localStorage
    }
  })
})
