import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import ErrorRenderer, {
  streetFasterThanTransitByMinutes
} from '../../../lib/components/narrative/metro/metro-error-renderer'

function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.safeLoad(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

const walkItinerary = {
  duration: 622,
  legs: [{ mode: 'WALK', transitLeg: false }]
}
const busItinerary = {
  duration: 764,
  legs: [
    { mode: 'WALK', transitLeg: false },
    { mode: 'BUS', transitLeg: true },
    { mode: 'WALK', transitLeg: false }
  ]
}

function render(
  itineraries: any[],
  errors: Record<string, Set<any>> = {
    WALKING_BETTER_THAN_TRANSIT: new Set([null])
  }
) {
  const state: any = getMockInitialState()
  state.otp.config = { ...state.otp.config, itinerary: {} }
  const { wrapper } = mockWithProvider(
    ErrorRenderer,
    { errors, itineraries },
    state,
    messages
  )
  return wrapper
}

describe('components > narrative > metro error renderer', () => {
  describe('streetFasterThanTransitByMinutes', () => {
    it('returns the whole-minute gap between the best walk and the best bus', () => {
      // Southdale, 2026-09-02 16:37: walk 622s, best bus 764s.
      expect(
        streetFasterThanTransitByMinutes([walkItinerary, busItinerary])
      ).toBe(2)
    })

    it('returns null when no transit itinerary came back', () => {
      expect(streetFasterThanTransitByMinutes([walkItinerary])).toBeNull()
    })

    it('returns null when transit is not actually slower', () => {
      expect(
        streetFasterThanTransitByMinutes([
          { duration: 2400, legs: [{ mode: 'WALK', transitLeg: false }] },
          busItinerary
        ])
      ).toBeNull()
    })
  })

  it('keeps the full warning when there is nothing on screen behind it', () => {
    expect(render([]).text()).toContain(
      "Transit isn't the fastest way to make this trip"
    )
  })

  it('demotes the warning to one advisory line once options are listed', () => {
    // The rider does not measure a trip only by which option is fastest, so
    // "walking is faster" must never occupy the space where the options go.
    const text = render([walkItinerary, busItinerary]).text()
    expect(text).not.toContain(
      "Transit isn't the fastest way to make this trip"
    )
    expect(text).toContain(
      'Walking is 2 min faster than the best transit option'
    )
  })

  it('drops the number when only the street option came back', () => {
    const text = render([walkItinerary]).text()
    expect(text).not.toContain(
      "Transit isn't the fastest way to make this trip"
    )
    expect(text).toContain('Walking is faster than transit for this trip')
  })

  describe('FEW_TRANSIT_ROUTES (backlog 14.2, answer b)', () => {
    it('renders one advisory line, styled like 22.2’s', () => {
      const wrapper = render([busItinerary], {
        FEW_TRANSIT_ROUTES: new Set(),
        // Raised by the walk+transit call at 00:02 and hidden on purpose.
        NO_TRANSIT_CONNECTION_IN_SEARCH_WINDOW: new Set([null])
      })
      expect(wrapper.text()).toContain('Few routes run at this hour.')
      expect(wrapper.text()).not.toContain('search window')
      const lines = wrapper.find('li.advisory')
      expect(lines).toHaveLength(1)
      // No headline and no clock time.
      expect(lines.find('h2')).toHaveLength(0)
      expect(lines.text()).not.toMatch(/\d:\d\d/)
    })

    it('uses the same markup as the NO_TRANSIT_OPTION_FOUND line', () => {
      const few = render([busItinerary], { FEW_TRANSIT_ROUTES: new Set() })
        .find('li.advisory')
        .first()
      const none = render([walkItinerary], {
        NO_TRANSIT_OPTION_FOUND: new Set()
      })
        .find('li.advisory')
        .first()
      expect(few.prop('className')).toBe(none.prop('className'))
      expect(few.children().map((c) => c.name())).toEqual(
        none.children().map((c) => c.name())
      )
    })

    it('renders nothing for it when the key is absent', () => {
      expect(render([busItinerary], {}).text()).not.toContain(
        'Few routes run at this hour.'
      )
    })
  })
})
