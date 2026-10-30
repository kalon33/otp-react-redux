/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { ClassicLegIcon, ClassicModeIcon } from '@opentripplanner/icons'
import clone from 'lodash/cloneDeep'
import React from 'react'
import yaml from 'js-yaml'

import { ComponentContext } from '../../../lib/util/contexts'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { pendingComboKind } from '../../../lib/actions/api-utils'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import MetroItinerary from '../../../lib/components/narrative/metro/metro-itinerary'
import NarrativeItineraries from '../../../lib/components/narrative/narrative-itineraries'
import responses from '../../test-utils/mock-data/0921-0912-search-responses.json'

/**
 * The results list's route-lock notes, mounted the way the app mounts the
 * list (harness from narrative-itineraries-search-pending.tsx).
 *
 * Fixture: the 2026-09-21 09:12:07 search's three responses — index 0
 * walk + transit (27 itineraries), 1 bike only (1), 2 bike + transit (17).
 */

function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.load(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

const SEARCH_ID = 'search-58-2'
// The combinations as routingQuery builds them for walk + transit, bike,
// bike + transit.
const COMBOS = [
  { modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }] },
  { modes: [{ mode: 'BICYCLE' }] },
  { modes: [{ mode: 'BICYCLE' }, { mode: 'TRANSIT' }] }
]

const reducer = createOtpReducer({})

const responseAction = (index: number) => ({
  payload: {
    index,
    response: {
      plan: clone({
        itineraries: (responses as any)[String(index)].itineraries
      }),
      requestId: SEARCH_ID
    },
    searchId: SEARCH_ID
  },
  type: 'ROUTING_RESPONSE'
})
function requested(routeLock?: any) {
  const base = getMockInitialState().otp
  // The search's query is a clone of currentQuery (the page title reads it).
  base.currentQuery.from = { lat: 44.948, lon: -93.287, name: 'Lake St' }
  base.currentQuery.to = { lat: 44.857, lon: -93.29, name: '98th St' }
  base.currentQuery.routeLock = routeLock
  return reducer(base, {
    payload: {
      activeItinerary: null,
      pending: COMBOS.length,
      pendingCombos: COMBOS.map(pendingComboKind),
      searchId: SEARCH_ID
    },
    type: 'ROUTING_REQUEST'
  })
}

// The shipped results-list config (app-config.yml:462-483): no header text,
// no skeletons — the spinner after the list was the only pending signal.
const SHIPPED_ITINERARY_CONFIG = {
  customBatchUiBackground: true,
  defaultFareType: { mediumId: null, riderCategoryId: null },
  groupByMode: true,
  groupTransitModes: true,
  hideSkeletons: true,
  mergeByRouteSignature: true,
  mergeItineraries: true,
  showBatchUiItineraryHeaders: false,
  showHeaderText: false
}

function mountList(searchOtp: any) {
  const state = getMockInitialState()
  const otp = {
    ...searchOtp,
    config: {
      ...searchOtp.config,
      itinerary: { ...searchOtp.config?.itinerary, ...SHIPPED_ITINERARY_CONFIG }
    }
  }
  // The app's components (tmp/config.js): MetroItinerary rows, classic icons.
  const List = () => (
    <ComponentContext.Provider
      value={
        {
          ItineraryBody: MetroItinerary,
          LegIcon: ClassicLegIcon,
          ModeIcon: ClassicModeIcon
        } as any
      }
    >
      <NarrativeItineraries />
    </ComponentContext.Provider>
  )
  return mockWithProvider(List, {}, { ...state, otp }, messages)
}
/**
 * 58.2, cycle 27 Q4 — a route set the network cannot join is answered with
 * bike-the-whole-way rows (and, here, rows on other routes), each marked
 * "Doesn't use {routes}". When EVERY row misses, the list says so once, on
 * top, instead of on every row.
 */
const settled = (routeLock: any) =>
  [0, 1, 2].reduce(
    (otp, index) => reducer(otp, responseAction(index)),
    requested(routeLock)
  )
const lock = (...ids: string[]) => ({
  routes: ids.map((id) => ({ id, label: id.split(':')[1] })),
  scope: 'only'
})
const topNote = (wrapper: any) =>
  wrapper.find('.route-lock-none-note').hostNodes()
const rowNotes = (wrapper: any) =>
  wrapper
    .find('li.result')
    .filterWhere((li: any) => li.text().includes('Doesn’t use'))

describe('58.2 > one line on top when no row uses the named routes', () => {
  it('a set no row rides: the line on top, no per-row repeats', () => {
    // Routes 5 and 21 appear in none of the 0921 search's 45 itineraries.
    const { wrapper } = mountList(settled(lock('1:5', '1:21')))
    expect(topNote(wrapper)).toHaveLength(1)
    expect(topNote(wrapper).text()).toBe(
      'No trip here uses 5, 21, so these are the bike options.'
    )
    expect(rowNotes(wrapper)).toHaveLength(0)
  })

  it('a set some rows ride: no line on top, the misses keep their own note', () => {
    const { wrapper } = mountList(settled(lock('1:904')))
    expect(topNote(wrapper)).toHaveLength(0)
    expect(rowNotes(wrapper).length).toBeGreaterThan(0)
  })

  it('says nothing while the search is still coming in', () => {
    const otp = reducer(requested(lock('1:5')), responseAction(1))
    const { wrapper } = mountList(otp)
    expect(topNote(wrapper)).toHaveLength(0)
  })

  it('reads a pre-09-02 single-route lock too', () => {
    const { wrapper } = mountList(settled({ id: '1:5', label: '5' }))
    expect(topNote(wrapper).text()).toContain('No trip here uses 5')
  })

  it('a starting route no trip starts on says so its own way', () => {
    const { wrapper } = mountList(
      settled({ routes: [{ id: '1:5', label: '5' }], scope: 'starting' })
    )
    expect(topNote(wrapper).text()).toBe(
      'No trip here starts on 5 — showing every trip.'
    )
  })
})

describe('75.22a > fare-less cards format no currency', () => {
  it('mounting the 0921 results logs no FORMAT_ERROR', () => {
    // FAILS BEFORE: intl.formatNumber(transitFare, {style:'currency'}) ran
    // before the fareKnown check, with no currency, on every fare-less card.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { wrapper } = mountList(settled(lock('1:904')))
      expect(wrapper.find('li.result').length).toBeGreaterThan(0)
      const formatErrors = spy.mock.calls.filter((c) =>
        String(c[0]).includes('Currency code is required')
      )
      expect(formatErrors).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
  })
})
