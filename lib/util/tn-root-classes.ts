import coreUtils from '@opentripplanner/core-utils'

/** Class on <html> while the phone layout (.otp.mobile) is the one rendered. */
export const TN_MOBILE_ROOT_CLASS = 'tn-mobile'

/**
 * Mark <html> for the TransitNav design system (lib/styles/tokens.css,
 * lib/styles/base.css).
 *
 * The mobile layout is chosen by user agent (coreUtils.ui.isMobile), not by
 * width, and several mobile surfaces render OUTSIDE the `.otp.mobile`
 * container: the app-menu drawer (a react-modal portal on <body>), the Go Mode
 * screen, and the AppFrame pages (/settings, /feedback, saved places). A class
 * on <html> is the one hook all of them sit under, and it is what turns the
 * dark tokens on — the desktop layout stays light.
 */
export function applyTnRootClasses(): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(
    TN_MOBILE_ROOT_CLASS,
    coreUtils.ui.isMobile()
  )
}
