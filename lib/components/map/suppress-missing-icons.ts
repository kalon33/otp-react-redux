import * as maplibregl from 'maplibre-gl'

import { MAKI_ICON_MAPPINGS } from './maki-icon-mappings'

/**
 * A fully transparent 1x1 RGBA pixel, used as a fallback placeholder when
 * a Maki icon cannot be loaded.
 */
const TRANSPARENT_PIXEL = {
  data: new Uint8Array([0, 0, 0, 0]),
  height: 1,
  width: 1
}

/**
 * Mapbox CDN URL for Maki icons (SVG format)
 * These are the standard Maki icons used by many basemap styles.
 */
const MAKI_ICON_BASE_URL =
  'https://raw.githubusercontent.com/mapbox/maki/main/icons'

/**
 * Cache of loaded Maki icons to avoid duplicate requests
 */
const loadedMakiIcons: Set<string> = new Set()

/**
 * `react-map-gl`/`MapLibre` event handler for the `styleimagemissing` event.
 *
 * Strategy:
 * 1. Check if the missing icon name maps to a Maki icon ID
 * 2. If it does, load that Maki icon from the Mapbox GitHub repo and add it to the map
 * 3. If no mapping exists or loading fails, register a transparent placeholder
 *
 * This approach loads actual Maki icons for the missing OSM POI categories,
 * providing proper visual representation instead of transparent placeholders.
 */
export function handleStyleImageMissing(
  e: maplibregl.MapStyleImageMissingEvent
): void {
  const map = e.target
  const { id } = e

  // Ignore numeric IDs or invalid image names
  if (typeof id !== 'string' || /^\d+$/.test(id)) {
    return
  }

  // Guard against duplicate processing
  if (map.hasImage(id)) {
    return
  }

  // Check if this missing icon has a Maki icon mapping
  const makiIconId = MAKI_ICON_MAPPINGS[id]

  if (makiIconId && !loadedMakiIcons.has(makiIconId)) {
    loadedMakiIcons.add(makiIconId)

    // Load the Maki icon from GitHub
    const iconUrl = `${MAKI_ICON_BASE_URL}/${makiIconId}.svg`

    // Use map.loadImage to fetch the SVG and add it
    // Note: loadImage returns a Promise, so we need to handle it asynchronously
    map
      .loadImage(iconUrl)
      .then((image) => {
        // Successfully loaded the Maki icon
        map.addImage(makiIconId, image.data)
        map.addImage(id, image.data)
      })
      .catch((error) => {
        console.warn(`Failed to load Maki icon ${makiIconId} for ${id}:`, error)
        // Fall back to transparent placeholder
        if (!map.hasImage(id)) {
          map.addImage(id, TRANSPARENT_PIXEL)
        }
      })
  } else if (!makiIconId) {
    // No Maki mapping exists for this icon, use transparent placeholder
    map.addImage(id, TRANSPARENT_PIXEL)
  }
}
