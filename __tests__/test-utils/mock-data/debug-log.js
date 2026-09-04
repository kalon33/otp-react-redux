/* eslint-disable @typescript-eslint/no-empty-function */
/**
 * Jest stand-in for lib/util/debug-log.js, which uses `import.meta` (Vite
 * env) and cannot be parsed by jest's CJS transform. Diagnostics are
 * side-effect-only, so no-ops preserve test semantics (recording off).
 */
export function isTripRecordingEnabled() {
  return false
}

export function createDebugLogMiddleware() {
  return () => (next) => (action) => next(action)
}

export function installGlobalErrorCapture() {}

/**
 * Recorded rather than dropped, so a test can assert that a caught render
 * error is reported (lib/components/util/error-boundary.tsx).
 */
export const recordedSessionEvents = []

export function recordSessionEvent(event, fields) {
  recordedSessionEvents.push({ event, ...fields })
}

export function startDebugLog() {}
