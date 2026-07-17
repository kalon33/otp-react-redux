import {
  applyRoutingPreferences,
  clampPreferences,
  DEFAULT_PROFILE_ID,
  extendPlanQueryWithLevers,
  getRoutingProfile,
  LEVER_RANGES,
  NON_OTP_QUERY_KEYS,
  ROUTING_PROFILES
} from '../../lib/util/routing-profiles'

describe('routing-profiles', () => {
  describe('ROUTING_PROFILES', () => {
    it('has a unique id per profile', () => {
      const ids = ROUTING_PROFILES.map((p) => p.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    it('includes the default profile id', () => {
      expect(getRoutingProfile(DEFAULT_PROFILE_ID)).toBeDefined()
    })

    it('only uses preference values within their allowed ranges', () => {
      ROUTING_PROFILES.forEach((profile) => {
        Object.entries(profile.prefs).forEach(([key, value]) => {
          const [min, max] = LEVER_RANGES[key as keyof typeof LEVER_RANGES]
          expect(value).toBeGreaterThanOrEqual(min)
          expect(value).toBeLessThanOrEqual(max)
        })
      })
    })

    it('has all required profile IDs', () => {
      const expectedIds = [
        'fastest',
        'minimize-walking',
        'stay-seated',
        'bike-forward',
        'avoid-biking',
        'reliable-transfers'
      ]
      const actualIds = ROUTING_PROFILES.map((p) => p.id)
      expectedIds.forEach((id) => {
        expect(actualIds).toContain(id)
      })
    })

    it('has all required profile labels', () => {
      const expectedLabels = [
        'fastest',
        'minimize-walking',
        'stay-seated',
        'bike-forward',
        'avoid-biking',
        'reliable-transfers'
      ]
      const actualLabels = ROUTING_PROFILES.map((p) => p.label)
      expectedLabels.forEach((label) => {
        expect(actualLabels).toContain(label)
      })
    })

    describe('getRoutingProfile', () => {
      it('returns a profile for a known id', () => {
        expect(getRoutingProfile('stay-seated')).toBeDefined()
      })

      it('returns undefined for an unknown id', () => {
        expect(getRoutingProfile('does-not-exist')).toBeUndefined()
      })
    })

  describe('clampPreferences', () => {
    it('returns an empty object for undefined input', () => {
      expect(clampPreferences()).toEqual({})
    })

