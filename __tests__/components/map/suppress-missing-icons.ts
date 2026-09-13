import {
  handleStyleImageMissing,
  resetLoadedMakiIcons
} from '../../../lib/components/map/suppress-missing-icons'

/**
 * Minimal fake map implementing the subset of MapLibre's API that
 * handleStyleImageMissing touches. The handler only needs hasImage,
 * addImage, removeImage and loadImage.
 */
function makeFakeMap(loadedImage = { data: new Uint8Array([1, 2, 3, 4]) }) {
  const images = new Map<string, unknown>()
  let loadImageShouldFail = false
  const map = {
    _failNextLoad: () => {
      loadImageShouldFail = true
    },
    _images: images,
    addImage: (id: string, data: unknown) => {
      images.set(id, data)
    },
    hasImage: (id: string) => images.has(id),
    loadImage: (url: string) =>
      loadImageShouldFail
        ? Promise.reject(new Error('network'))
        : Promise.resolve(loadedImage),
    removeImage: (id: string) => {
      images.delete(id)
    }
  }
  return map
}

describe('map > suppress-missing-icons > handleStyleImageMissing', () => {
  beforeEach(() => {
    resetLoadedMakiIcons()
  })

  it('adds a placeholder synchronously for a mapped icon', () => {
    const map = makeFakeMap()
    handleStyleImageMissing({ id: 'bollard', target: map } as any)
    expect(map.hasImage('bollard')).toBe(true)
  })

  it('replaces the placeholder with the loaded Maki icon on success', async () => {
    const realIcon = { data: new Uint8Array([9, 9, 9, 9]) }
    const map = makeFakeMap(realIcon)
    handleStyleImageMissing({ id: 'bollard', target: map } as any)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(map.hasImage('bollard')).toBe(true)
    expect(map._images.get('bollard')).toBe(realIcon.data)
    expect(map.hasImage('barrier')).toBe(true)
  })

  it('keeps the placeholder when the Maki icon fails to load', async () => {
    const map = makeFakeMap()
    map._failNextLoad()
    handleStyleImageMissing({ id: 'gate', target: map } as any)
    expect(map.hasImage('gate')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(map.hasImage('gate')).toBe(true)
  })

  it('adds a placeholder for an icon with no Maki mapping', () => {
    const map = makeFakeMap()
    handleStyleImageMissing({ id: 'unknown-poi', target: map } as any)
    expect(map.hasImage('unknown-poi')).toBe(true)
  })

  it('ignores numeric ids', () => {
    const map = makeFakeMap()
    handleStyleImageMissing({ id: '12345', target: map } as any)
    expect(map.hasImage('12345')).toBe(false)
  })

  it('does not refetch an already loading Maki icon for a second id', async () => {
    const realIcon = { data: new Uint8Array([8, 8, 8, 8]) }
    const map = makeFakeMap(realIcon)
    let loads = 0
    const origLoad = map.loadImage
    map.loadImage = (url: string) => {
      loads++
      return origLoad(url)
    }
    handleStyleImageMissing({ id: 'gate', target: map } as any)
    handleStyleImageMissing({ id: 'lift_gate', target: map } as any)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loads).toBe(1)
    expect(map.hasImage('gate')).toBe(true)
    expect(map.hasImage('lift_gate')).toBe(true)
    expect(map._images.get('gate')).toBe(realIcon.data)
    expect(map._images.get('lift_gate')).toBe(realIcon.data)
  })
})
