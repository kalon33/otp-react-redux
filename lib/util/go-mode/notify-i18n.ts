import { createIntl } from 'react-intl'
import type { IntlShape } from 'react-intl'

/**
 * notify-i18n.ts — the `intl` handle Go Mode's alert copy formats through.
 *
 * Why a module singleton rather than the repo's usual "pass `intl` in" habit
 * (lib/util/state.js, lib/util/monitored-trip.ts): every notification builder
 * in notification-service.ts is called from the Go Mode tick in
 * lib/actions/go-mode.ts, which has no React context and no `intl` of its own.
 * Threading one through would mean changing ~20 signatures and the tick that
 * calls them, and it would still have to come from somewhere — the store is
 * where the catalogue already lives.
 *
 * So the locale is registered once, from the one place that knows it changed:
 * `setLocale` in lib/actions/ui.js, beside the `UPDATE_LOCALE` dispatch that
 * puts the same pair into `state.otp.ui`. There is exactly one locale and one
 * rider per page, so a module-level handle is the same fact the IntlProvider
 * holds, reachable from code that is not a component.
 *
 * Before registration — unit tests, and the moment before the first locale
 * load resolves — {@link notifyIntl} hands back an English handle with an
 * EMPTY catalogue, so every `formatMessage` falls through to its own
 * `defaultMessage`. That is deliberate: the default in the call site is the
 * single source of the English copy, and `check:i18n-en-fr` extracts it, so a
 * string can never again exist in code without a key in both message files.
 */

let registered: IntlShape | null = null
let fallback: IntlShape | null = null

/**
 * Silent on a missing translation. A locale that has not been fully translated
 * yet falls back to `defaultMessage`, which is the right answer and not worth a
 * console error on every GPS tick that raises an alert.
 */
const onError = () => undefined

/** Point the notification copy at a locale. Called from `setLocale`. */
export function setNotifyLocale(
  locale: string,
  messages: Record<string, string>
): void {
  registered = createIntl({ locale, messages, onError })
}

/** The handle to format alert copy with. Never null — see the module note. */
export function notifyIntl(): IntlShape {
  if (registered) return registered
  if (!fallback) {
    fallback = createIntl({ locale: 'en-US', messages: {}, onError })
  }
  return fallback
}

/** Test seam: forget the registered locale. */
export function resetNotifyLocale(): void {
  registered = null
}
