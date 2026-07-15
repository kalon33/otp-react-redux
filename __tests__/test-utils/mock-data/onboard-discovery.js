/**
 * Jest stand-in for lib/util/go-mode/onboard-discovery.js, which reads
 * `import.meta` (Vite env) and cannot be parsed by jest's CJS transform.
 * Resolving null means "sidecar unreachable" — thunks take the legacy
 * stop-radius fallback, the semantics tests were written against.
 */
export async function fetchOnboardCandidateRoutes() {
  return null
}
