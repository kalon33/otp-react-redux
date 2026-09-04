import {
  adoptNamedCustomPlaces,
  builtInTypeForName,
  isCustomPlace,
  toBuiltInPlace
} from '../../lib/util/saved-places'

const OLD_SHAKOPEE = {
  address: '2345 Old Shakopee Road West',
  icon: 'map-marker',
  id: 'place-abc123',
  lat: 44.8168,
  lon: -93.3102,
  name: 'Home',
  type: 'custom'
}

describe('lib > util > saved-places', () => {
  describe('builtInTypeForName', () => {
    it('matches Home and Work however the rider typed them', () => {
      expect(builtInTypeForName('Home')).toEqual('home')
      expect(builtInTypeForName('home')).toEqual('home')
      expect(builtInTypeForName('  HOME  ')).toEqual('home')
      expect(builtInTypeForName('Work')).toEqual('work')
      expect(builtInTypeForName('work ')).toEqual('work')
    })

    it('does not match names that merely contain them', () => {
      expect(builtInTypeForName('Home gym')).toBeNull()
      expect(builtInTypeForName("Mom's home")).toBeNull()
      expect(builtInTypeForName('Workshop')).toBeNull()
      expect(builtInTypeForName('')).toBeNull()
      expect(builtInTypeForName(undefined)).toBeNull()
      expect(builtInTypeForName(null)).toBeNull()
    })
  })

  describe('toBuiltInPlace', () => {
    it('re-shapes a custom place into the built-in slot', () => {
      expect(toBuiltInPlace(OLD_SHAKOPEE, 'home')).toEqual({
        address: '2345 Old Shakopee Road West',
        icon: 'home',
        lat: 44.8168,
        lon: -93.3102,
        name: '2345 Old Shakopee Road West',
        timestamp: undefined,
        type: 'home'
      })
    })

    it('uses the briefcase icon for work and drops the custom id', () => {
      const work = toBuiltInPlace({ ...OLD_SHAKOPEE, name: 'Work' }, 'work')
      expect(work.icon).toEqual('briefcase')
      expect(work.type).toEqual('work')
      expect(work.id).toBeUndefined()
      // The result is no longer a custom place, so it never round-trips
      // back into the savedPlaces key.
      expect(isCustomPlace(work)).toBe(false)
    })
  })

  describe('adoptNamedCustomPlaces', () => {
    it('adopts a custom "Home" into an empty home slot', () => {
      const { adopted, locations } = adoptNamedCustomPlaces([OLD_SHAKOPEE])
      expect(adopted).toHaveLength(1)
      expect(locations).toHaveLength(1)
      expect(locations[0].type).toEqual('home')
      expect(locations[0].address).toEqual('2345 Old Shakopee Road West')
      expect(locations.filter(isCustomPlace)).toHaveLength(0)
    })

    it('leaves the custom row alone when the slot already holds an address', () => {
      const existingHome = {
        address: '1 Home St',
        icon: 'home',
        lat: 1,
        lon: 2,
        name: '1 Home St',
        type: 'home'
      }
      const { adopted, locations } = adoptNamedCustomPlaces([
        existingHome,
        OLD_SHAKOPEE
      ])
      expect(adopted).toHaveLength(0)
      expect(locations).toEqual([existingHome, OLD_SHAKOPEE])
    })

    it('is idempotent — a second pass adopts nothing', () => {
      const first = adoptNamedCustomPlaces([OLD_SHAKOPEE])
      const second = adoptNamedCustomPlaces(first.locations)
      expect(second.adopted).toHaveLength(0)
      expect(second.locations).toEqual(first.locations)
    })

    it('never touches suggested places or other custom names', () => {
      const gym = { ...OLD_SHAKOPEE, id: 'place-gym', name: 'Gym' }
      const suggested = {
        address: 'Library',
        name: 'Library',
        type: 'suggested'
      }
      const { adopted, locations } = adoptNamedCustomPlaces([gym, suggested])
      expect(adopted).toHaveLength(0)
      expect(locations).toEqual([gym, suggested])
    })

    it('skips an addressless row rather than manufacturing a home', () => {
      const { adopted } = adoptNamedCustomPlaces([
        { ...OLD_SHAKOPEE, address: '' }
      ])
      expect(adopted).toHaveLength(0)
    })

    it('adopts Home and Work independently in one pass', () => {
      const work = {
        ...OLD_SHAKOPEE,
        address: '900 Office Pkwy',
        id: 'place-w',
        name: 'work'
      }
      const { adopted } = adoptNamedCustomPlaces([OLD_SHAKOPEE, work])
      expect(adopted.map((p) => p.type).sort()).toEqual(['home', 'work'])
    })

    it('adopts only the first of two custom places with the same name', () => {
      const second = { ...OLD_SHAKOPEE, address: '9 Other St', id: 'place-2' }
      const { adopted, locations } = adoptNamedCustomPlaces([
        OLD_SHAKOPEE,
        second
      ])
      expect(adopted).toHaveLength(1)
      expect(locations[1]).toEqual(second)
    })
  })
})
