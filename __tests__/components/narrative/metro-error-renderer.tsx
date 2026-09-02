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

function render(itineraries: any[]) {
  const state: any = getMockInitialState()
  state.otp.config = { ...state.otp.config, itinerary: {} }
  const { wrapper } = mockWithProvider(
    ErrorRenderer,
    { errors: { WALKING_BETTER_THAN_TRANSIT: new Set([null]) }, itineraries },
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
})
