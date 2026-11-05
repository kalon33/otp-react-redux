/**
 * maplibre-gl 6 compatibility shim.
 *
 * maplibre-gl 6 is ESM-only and has NO default export, but compiled
 * dependencies still written for maplibre 5 do `import maplibregl from
 * "maplibre-gl"` (@opentripplanner/base-map 7.2.0 among them). Rollup fails
 * the build with '"default" is not exported by maplibre-gl' when such a file
 * is bundled — and that file only works today because a patch-package patch
 * rewrites it, a state yarn does not preserve across installs.
 *
 * vite.config.js aliases the bare specifier `maplibre-gl` to this module, so
 * EVERY importer gets both shapes regardless of node_modules' patch state:
 * the namespace as a default (for the maplibre 5-style imports) and all the
 * named exports (for `import * as` / named imports). The real bundle is
 * imported by path so the alias does not loop.
 *
 * The worker URL is unaffected: maplibre computes it from its own
 * import.meta.url inside the real .mjs, which the alias never touches.
 */
import * as maplibre from 'maplibre-gl/dist/maplibre-gl.mjs'

export default maplibre
export * from 'maplibre-gl/dist/maplibre-gl.mjs'
