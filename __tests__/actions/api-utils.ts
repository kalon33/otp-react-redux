import { TransportMode } from '@opentripplanner/types'

import {
  countFlexModes,
  filterWalkAccessCombinations
} from '../../lib/actions/api-utils'

const modes = (...list: (string | [string, string])[]): TransportMode[] =>
  list.map((m) =>
    Array.isArray(m) ? { mode: m[0], qualifier: m[1] } : { mode: m }
  ) as TransportMode[]

/**
 * The four combinations generateCombinations actually produces for this
 * deployment's default mode buttons (transit + bicycle, where the bicycle
 * button carries BICYCLE and BICYCLE/RENT).
 */
const shippedFanOut = [
  { modes: modes('TRANSIT') },
  { modes: modes('BICYCLE') },
  { modes: modes('TRANSIT', 'BICYCLE') },
  { modes: modes('TRANSIT', ['BICYCLE', 'RENT']) }
]

describe('actions > api-utils', () => {
  describe('countFlexModes', () => {
    it('counts only FLEX modes', () => {
      expect(countFlexModes(modes('WALK', 'FLEX', 'TRANSIT', 'FLEX'))).toBe(2)
    })
  })

  describe('filterWalkAccessCombinations (rider ask #48)', () => {
    it('does nothing when the toggle is off', () => {
      expect(filterWalkAccessCombinations(shippedFanOut, false)).toBe(
        shippedFanOut
      )
      expect(filterWalkAccessCombinations(shippedFanOut, undefined)).toBe(
        shippedFanOut
      )
    })

    it('drops only the transit call that has no personal access mode', () => {
      // Measured 2026-09-02 against the live graph: that one call is where
      // every WALK-BUS-WALK itinerary comes from, and the transit+bicycle call
      // returned no walk-access chains at all.
      const kept = filterWalkAccessCombinations(shippedFanOut, true)
      expect(kept).toHaveLength(3)
      expect(kept.map((c) => c.modes.map((m) => m.mode).join('+'))).toEqual([
        'BICYCLE',
        'TRANSIT+BICYCLE',
        'TRANSIT+BICYCLE'
      ])
    })

    it('keeps a qualified access mode such as BICYCLE_RENT', () => {
      const kept = filterWalkAccessCombinations(
        [{ modes: modes('TRANSIT', ['BICYCLE', 'RENT']) }],
        true
      )
      expect(kept).toHaveLength(1)
    })

    it('keeps flex, which is not walk access', () => {
      const flex = [{ modes: modes('TRANSIT', 'FLEX') }]
      expect(filterWalkAccessCombinations(flex, true)).toHaveLength(1)
    })

    it('refuses to empty the fan-out when walk is the only way to transit', () => {
      // Transit selected on its own: filtering would leave no query at all and
      // turn a working search into INVALID_MODE_SELECTION, so the toggle backs
      // off rather than breaking the search.
      const transitOnly = [{ modes: modes('TRANSIT') }]
      expect(filterWalkAccessCombinations(transitOnly, true)).toBe(transitOnly)
    })
  })
})
