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
 * In-flight Maki icon load promises, keyed by Maki icon id, so that several
 * missing image ids mapping to the same Maki icon share a single loadImage
 * call while still each getting their own placeholder replaced.
 */
const pendingMakiLoads = new Map<
  string,
  ReturnType<maplibregl.Map['loadImage']>
>()

export function resetLoadedMakiIcons(): void {
  pendingMakiLoads.clear()
}

/**
 * `react-map-gl`/`MapLibre` event handler for the `styleimagemissing` event.
 *
 * Strategy:
 * 1. Register a transparent placeholder immediately so MapLibre stops
 *    emitting styleimagemissing (and the associated console warning) for
 *    this id while the real Maki icon is fetched asynchronously.
 * 2. If the missing icon name maps to a Maki icon ID, load that Maki icon
 *    from the Mapbox GitHub repo and replace the placeholder once loaded.
 * 3. If no mapping exists or loading fails, the placeholder remains.
 */
export function handleStyleImageMissing(
  e: maplibregl.MapStyleImageMissingEvent
): void {
  const map = e.target
  const { id } = e

  if (typeof id !== 'string' || /^\d+$/.test(id)) {
    return
  }

  if (map.hasImage(id)) {
    return
  }

  map.addImage(id, TRANSPARENT_PIXEL)

  const makiIconId = MAKI_ICON_MAPPINGS[id]

  if (makiIconId) {
    const applyIcon = (
      image: Awaited<ReturnType<maplibregl.Map['loadImage']>>
    ) => {
      if (!map.hasImage(makiIconId)) {
        map.addImage(makiIconId, image.data)
      }
      if (map.hasImage(id)) {
        map.removeImage(id)
      }
      map.addImage(id, image.data)
    }

    let loadPromise = pendingMakiLoads.get(makiIconId)
    if (!loadPromise) {
      const iconUrl = `${MAKI_ICON_BASE_URL}/${makiIconId}.svg`
      loadPromise = map.loadImage(iconUrl).then(
        (image) => {
          pendingMakiLoads.delete(makiIconId)
          return image
        },
        (error) => {
          pendingMakiLoads.delete(makiIconId)
          throw error
        }
      )
      pendingMakiLoads.set(makiIconId, loadPromise)
    }

    loadPromise.then(applyIcon).catch((error) => {
      console.warn(`Failed to load Maki icon ${makiIconId} for ${id}:`, error)
    })
  }
}
