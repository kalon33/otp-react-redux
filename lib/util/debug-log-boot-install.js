/**
 * Arm the boot crash path — the FIRST thing the app does.
 *
 * `main.js` imports this for its side effect, above every other import. ES
 * module imports are evaluated in order and before any statement in the
 * importing module's body, so this is the only way to have error handlers in
 * place while the config, the store and the component tree are still being
 * evaluated. A `startBootCrashCapture()` call at the top of main.js's body
 * would run AFTER all of them — which is precisely why the 2026-09-02 white
 * screen produced no telemetry at all.
 *
 * All this file holds is the wiring that needs Vite's `import.meta.env`. The
 * logic lives in debug-log-boot.js, which stays free of it so Jest can parse
 * and test it (the same split, for the same reason, as debug-log-batch.js).
 */

import { getRunningBundle } from './native-updates'
import { installBootCrashCapture, noteBundleVersion } from './debug-log-boot'

// Same two values debug-log.js resolves, and they must stay the same: a crash
// beacon and the session it belongs to have to reach one sink. Web builds
// leave VITE_API_BASE_URL unset (same origin, behind the auth gate); the
// bundled native app runs from capacitor://localhost and its build sets the
// absolute URL, so the POST goes cross-origin (CORS'd, unauthenticated,
// rate-limited on the server).
const API_BASE =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) ||
  ''
const BUILD_INFO =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BUILD_INFO) ||
  'dev'

installBootCrashCapture({
  build: BUILD_INFO,
  endpoint: `${API_BASE}/api/debug-log`
})

// Which OTA bundle is running is the single most useful field on a crash
// report — "the white screen was 2026.0902.3" is the whole diagnosis on a good
// day — and the plugin only answers asynchronously. Ask now, so the answer is
// usually there by the time anything can throw. A crash inside the first tick
// legitimately reports no bundle rather than a guessed one.
getRunningBundle()
  .then((bundle) => noteBundleVersion(bundle?.version))
  .catch(() => {
    // No bridge (a browser), or the plugin refused: the report is still worth
    // sending without a bundle name.
  })
