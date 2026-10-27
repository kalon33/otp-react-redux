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
