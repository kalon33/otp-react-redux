import { readRaw, writeRaw } from './safe-storage'
import { TN_MOBILE_ROOT_CLASS } from './tn-root-classes'

/**
 * Whether the TransitNav dark theme is in effect right now: the phone layout
 * (html.tn-mobile) with the OS in dark mode, unless data-theme pins a scheme.
 * Mirrors the media/attribute guards in lib/styles/tokens.css.
 */
export function isTnDark(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return false
  }
  const root = document.documentElement
  const forced = root.getAttribute('data-theme')
  if (forced === 'dark') return true
  if (forced === 'light') return false
  return (
    root.classList.contains(TN_MOBILE_ROOT_CLASS) &&
    !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  )
}

/**
 * CARTO's Positron (light) and Dark Matter (dark) basemaps are the same
 * cartography in two palettes. In the dark theme, swap a configured Positron
 * style for Dark Matter so the map does not glow white under the dark UI.
 * Any other style URL is returned untouched.
 */
export function tnBaseLayerUrl(url: string): string {
  if (!url || !isTnDark()) return url
  return url.replace('positron-gl-style', 'dark-matter-gl-style')
}

/** The rider's Appearance choice (Settings → Appearance). */
export type TnThemePref = 'system' | 'light' | 'dark'

/** localStorage key holding the Appearance choice. */
export const TN_THEME_STORAGE_KEY = 'tnTheme'

/** Fired on window after the choice is applied, for render-time consumers. */
export const TN_THEME_CHANGE_EVENT = 'tn-theme-change'

function isThemePref(value: unknown): value is TnThemePref {
  return value === 'system' || value === 'light' || value === 'dark'
}

/** The stored Appearance choice; 'system' when unset, unreadable or junk. */
export function getTnThemePref(): TnThemePref {
  if (typeof window === 'undefined') return 'system'
  try {
    const stored = readRaw(TN_THEME_STORAGE_KEY)
    return isThemePref(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

/**
 * Put the Appearance choice (the stored one by default) on <html> as
 * `data-theme`, which tokens.css and isTnDark read before the OS scheme.
 * 'system' removes the attribute so the prefers-color-scheme block decides.
 *
 * Desktop guard: `data-theme="dark"` forces the dark tokens on ANY layout, and
 * the desktop layout is not built for them. So 'dark' is applied only when
 * html.tn-mobile is present (applyTnRootClasses must run first); on desktop it
 * behaves as 'system', which there means light.
 */
export function applyTnThemePref(pref: TnThemePref = getTnThemePref()): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const mobile = root.classList.contains(TN_MOBILE_ROOT_CLASS)
  if (pref === 'light') root.setAttribute('data-theme', 'light')
  else if (pref === 'dark' && mobile) root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme')
  window.dispatchEvent(new Event(TN_THEME_CHANGE_EVENT))
}

/**
 * Record the Appearance choice and apply it at once. If storage is blocked the
 * choice still applies for this session; it just will not survive a reload.
 */
export function setTnThemePref(pref: TnThemePref): void {
  // Never throws; a refused write is held for this session (safe-storage).
  writeRaw(TN_THEME_STORAGE_KEY, pref)
  applyTnThemePref(pref)
}
