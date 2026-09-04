import {
  isSameRecentPlace,
  mergeRecentPlace,
  normalizeRecentAddress,
  RECENT_PLACE_MATCH_METERS
} from '../../lib/util/recent-places'

const SOUTHDALE = {
  address: 'Southdale Mall, 50th and France, Edina, MN',
  icon: 'clock-o',
  id: 'recent-shsni9qi1',
  lat: 44.88768816033247,
  lon: -93.34570485903102,
  name: 'Southdale Mall, 50th and France, Edina, MN',
  timestamp: 1788537165044,
  type: 'recent'
}

describe('lib > util > recent-places', () => {
  it('normalizes case and runs of whitespace', () => {
    expect(normalizeRecentAddress('  Southdale   Mall ')).toEqual(
      'southdale mall'
    )
    expect(normalizeRecentAddress(undefined)).toEqual('')
  })

  it('matches identical coordinates', () => {
    expect(
      isSameRecentPlace(SOUTHDALE, { ...SOUTHDALE, id: 'recent-other' })
    ).toBe(true)
  })

  it('matches a point a few metres away', () => {
    // ~2 m north.
    const nudged = {
      ...SOUTHDALE,
      address: '',
      lat: SOUTHDALE.lat + 0.00002,
      name: ''
    }
    expect(isSameRecentPlace(SOUTHDALE, nudged)).toBe(true)
  })

  it('does not match a point well beyond the threshold', () => {
    // ~110 m north, different address.
    const far = {
      ...SOUTHDALE,
      address: 'Somewhere else',
      lat: SOUTHDALE.lat + 0.001,
      name: 'Somewhere else'
    }
    expect(isSameRecentPlace(SOUTHDALE, far)).toBe(false)
    expect(RECENT_PLACE_MATCH_METERS).toEqual(5)
  })

  it('matches the same address geocoded to different coordinates', () => {
    const regeocoded = {
      ...SOUTHDALE,
      lat: 44.8878,
      lon: -93.3459,
      name: 'southdale mall,  50TH and France, Edina, MN'
    }
    expect(isSameRecentPlace(SOUTHDALE, regeocoded)).toBe(true)
  })

  it('never matches on a blank address alone', () => {
    const a = { address: '', lat: 1, lon: 2, name: '' }
    const b = { address: '', lat: 40, lon: -90, name: '' }
    expect(isSameRecentPlace(a, b)).toBe(false)
  })

  it('handles missing places and missing coordinates', () => {
    expect(isSameRecentPlace(null, SOUTHDALE)).toBe(false)
    expect(isSameRecentPlace(SOUTHDALE, undefined)).toBe(false)
    expect(isSameRecentPlace({ address: 'A' }, { address: 'a' })).toBe(true)
  })

  it('merges a repeat visit onto the existing id', () => {
    const incoming = {
      ...SOUTHDALE,
      id: 'recent-gxln259t5',
      timestamp: 1788537167182
    }
    const merged = mergeRecentPlace(SOUTHDALE, incoming)
    expect(merged.id).toEqual('recent-shsni9qi1')
    expect(merged.timestamp).toEqual(1788537167182)
  })
})
