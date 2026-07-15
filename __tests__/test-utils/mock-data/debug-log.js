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

export function startDebugLog() {}
