/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  applyTnThemePref,
  getTnThemePref,
  isTnDark,
  setTnThemePref,
  TN_THEME_CHANGE_EVENT,
  TN_THEME_STORAGE_KEY,
  tnBaseLayerUrl
} from '../../lib/util/tn-theme'
import { TN_MOBILE_ROOT_CLASS } from '../../lib/util/tn-root-classes'

const POSITRON = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const DARK_MATTER =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'

function mockOsDark(dark: boolean) {
  const win = window as any
  win.matchMedia = jest.fn().mockImplementation((q: string) => ({
    matches: dark && q === '(prefers-color-scheme: dark)'
  }))
}

describe('util > tn-theme', () => {
  const root = document.documentElement

  beforeEach(() => {
    window.localStorage.clear()
    root.removeAttribute('data-theme')
    root.classList.add(TN_MOBILE_ROOT_CLASS)
    mockOsDark(false)
  })

  afterAll(() => {
    root.classList.remove(TN_MOBILE_ROOT_CLASS)
    root.removeAttribute('data-theme')
  })

  it('defaults to system when nothing (or junk) is stored', () => {
    expect(getTnThemePref()).toBe('system')
    window.localStorage.setItem(TN_THEME_STORAGE_KEY, 'purple')
    expect(getTnThemePref()).toBe('system')
  })

  it('persists the choice and applies it to <html>', () => {
    setTnThemePref('dark')
    expect(window.localStorage.getItem(TN_THEME_STORAGE_KEY)).toBe('dark')
    expect(getTnThemePref()).toBe('dark')
    expect(root.getAttribute('data-theme')).toBe('dark')

    setTnThemePref('light')
    expect(getTnThemePref()).toBe('light')
    expect(root.getAttribute('data-theme')).toBe('light')

    setTnThemePref('system')
    expect(getTnThemePref()).toBe('system')
    expect(root.getAttribute('data-theme')).toBeNull()
  })

  it('applies the stored choice at boot', () => {
    window.localStorage.setItem(TN_THEME_STORAGE_KEY, 'light')
    applyTnThemePref()
    expect(root.getAttribute('data-theme')).toBe('light')
  })

  it('never forces dark on the desktop layout', () => {
    root.classList.remove(TN_MOBILE_ROOT_CLASS)
    window.localStorage.setItem(TN_THEME_STORAGE_KEY, 'dark')
    applyTnThemePref()
    expect(root.getAttribute('data-theme')).toBeNull()
    expect(isTnDark()).toBe(false)

    setTnThemePref('dark')
    expect(root.getAttribute('data-theme')).toBeNull()
    expect(isTnDark()).toBe(false)
    // Light is still honoured on desktop (it is what desktop already is).
    setTnThemePref('light')
    expect(root.getAttribute('data-theme')).toBe('light')
  })

  it('isTnDark honours the choice over the OS scheme', () => {
    mockOsDark(false)
    setTnThemePref('dark')
    expect(isTnDark()).toBe(true)
    expect(tnBaseLayerUrl(POSITRON)).toBe(DARK_MATTER)

    mockOsDark(true)
    setTnThemePref('light')
    expect(isTnDark()).toBe(false)
    expect(tnBaseLayerUrl(POSITRON)).toBe(POSITRON)

    setTnThemePref('system')
    expect(isTnDark()).toBe(true)
    mockOsDark(false)
    expect(isTnDark()).toBe(false)
  })

  it('announces each change on window', () => {
    const listener = jest.fn()
    window.addEventListener(TN_THEME_CHANGE_EVENT, listener)
    setTnThemePref('dark')
    setTnThemePref('system')
    window.removeEventListener(TN_THEME_CHANGE_EVENT, listener)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('still applies when storage throws', () => {
    const spy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked')
      })
    setTnThemePref('dark')
    expect(root.getAttribute('data-theme')).toBe('dark')
    spy.mockRestore()
  })
})
