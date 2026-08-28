/**
 * Mapping from OSM POI icon names (that are missing from basemap sprites)
 * to Maki icon IDs.
 *
 * Maki is the standard icon set used by Mapbox GL styles and many basemaps.
 * See: https://labs.mapbox.com/maki-icons/
 */
export const MAKI_ICON_MAPPINGS: Record<string, string> = {
  archery: 'pitch',
  athletics: 'pitch',
  basin: 'water',
  bicycle_parking: 'bicycle-parking',
  bollard: 'barrier',
  brownfield: 'land-use',
  cycle_barrier: 'bicycle',
  cycling: 'bicycle',
  ferry_terminal: 'ferry',
  gate: 'gate',
  gymnastics: 'pitch',
  lift_gate: 'gate',
  multi: 'poi',
  office: 'building',
  recycling: 'recycling',
  sailing: 'marina',
  sports_centre: 'pitch',
  swimming_pool: 'swimming',
  table_tennis: 'pitch'
}
