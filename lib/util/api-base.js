/**
 * Where the app's own API lives.
 *
 * Web builds are same-origin behind the auth gate and leave VITE_API_BASE_URL
 * unset; the bundled native app runs at capacitor://localhost (iOS) or
 * https://localhost (Android) and sets the base to the server's absolute URL,
 * so the call goes cross-origin. Both native origins are in every endpoint's
 * ALLOWED_ORIGINS.
 *
 * A module of its own so a caller can be TESTED. `import.meta` is a syntax
 * error under jest's CJS transform, so any file that reads it is unmountable —
 * which is how lib/components/user/feedback-screen.tsx came to have no test at
 * all, and why the 2026-09-06 "Saved. It will send the next time you open this
 * screen." lie shipped with nothing asserting on it. package.json's
 * moduleNameMapper swaps this one file out, exactly as it already does for
 * util/debug-log and util/go-mode/onboard-discovery.
 */
export const API_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) ||
  ''

/** An absolute URL for one API path, e.g. apiUrl('/api/ride-note'). */
export function apiUrl(path) {
  return `${API_BASE}${path}`
}
