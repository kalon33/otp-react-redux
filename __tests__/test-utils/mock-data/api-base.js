/**
 * Jest stand-in for lib/util/api-base.js, which reads `import.meta` (Vite env)
 * and cannot be parsed by jest's CJS transform.
 *
 * Same-origin is the honest test default: it is what a web build sends, and a
 * test asserting on a fetch cares about the path, not the host.
 */
export const API_BASE = ''

export function apiUrl(path) {
  return path
}
