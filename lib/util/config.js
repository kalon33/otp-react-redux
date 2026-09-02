export const Modules = {
  CALL_TAKER: 'call',
  FIELD_TRIP: 'ft',
  MAILABLES: 'mailables'
}

export function getModuleConfig(state, moduleName) {
  return state.otp.config?.modules?.find((m) => m.id === moduleName)
}

export function isModuleEnabled(state, moduleName) {
  return Boolean(getModuleConfig(state, moduleName))
}

export function checkForRouteModeOverride(route, overrideConfig) {
  return overrideConfig?.[route.id] || route.mode
}

/**
 * The path portion of OTP2's vector tile endpoint, e.g.
 * "/otp/routers/default/vectorTiles".
 *
 * OTP2 serves vector tiles from the old REST router path
 * (`@Path("/routers/{ignoreRouterId}/vectorTiles")` in VectorTilesResource), so
 * the frontend has to name that path even though nothing else about OTP1's REST
 * API survives. It used to read `api.path` for it, but `api.path` is the OTP1
 * REST path and every OTP2 deployment leaves it unset on purpose — setting it
 * would re-arm the dead OTP1 endpoints (see the note above findNearbyStops in
 * actions/apiV2.js). Unset, it interpolated as the literal string "undefined"
 * and every tile request went to ".../api.transit-nav.comundefined/vectorTiles",
 * so the stop layer could never load and nothing said why.
 *
 * `api.basePath` is honoured so a deployment proxied somewhere other than /otp
 * still resolves, and an explicitly configured `api.path` still wins.
 *
 * @param {object} api the `api` section of the app config
 * @return {string} a path with a leading slash and no trailing slash
 */
export function getVectorTilesPath(api) {
  const routerPath = api?.path ?? `${api?.basePath ?? '/otp'}/routers/default`
  return `${routerPath}/vectorTiles`
}
