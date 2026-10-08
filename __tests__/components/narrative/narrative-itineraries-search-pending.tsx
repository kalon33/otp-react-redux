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
import { getSearchPendingKind } from '../../../lib/components/narrative/search-pending-line'
import { pendingComboKind } from '../../../lib/actions/api-utils'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import MetroItinerary from '../../../lib/components/narrative/metro/metro-itinerary'
import NarrativeItineraries from '../../../lib/components/narrative/narrative-itineraries'
import responses from '../../test-utils/mock-data/0921-0912-search-responses.json'

/**
 * Backlog 38.3 — rider 2026-09-30 16:12:10: "Can we increase the speed of the
 * bike + bus search at all by returning results as they come in? ... With a
 * message telling user more results are coming?"
 *
 * The list already paints each fan-out combination as it lands. What it did
 * not do is say so: `showHeaderText: false` and `hideSkeletons: true` left a
 * spinner AFTER the list as the only signal, while bike + transit (index 2,
 * median 8.0 s on the rider's phone, n = 24) was still out.
 *
 * Fixture: the 2026-09-21 09:12:07 search's three responses — index 0
 * walk + transit (27 itineraries), 1 bike only (1), 2 bike + transit (17) —
 * the same fan-out shape as the rider's searches.
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
  yaml.safeLoad(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

const SEARCH_ID = 'search-38-3'
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
const errorAction = (index: number) => ({
  payload: { error: new Error('timeout'), index, searchId: SEARCH_ID },
  type: 'ROUTING_ERROR'
})

function requested() {
  const base = getMockInitialState().otp
  // The search's query is a clone of currentQuery (the page title reads it).
  base.currentQuery.from = { lat: 44.948, lon: -93.287, name: 'Lake St' }
  base.currentQuery.to = { lat: 44.857, lon: -93.29, name: '98th St' }
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

const kindOf = (otp: any) => getSearchPendingKind(otp.searches[SEARCH_ID])

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
const lineText = (wrapper: any) => {
  const line = wrapper.find('[data-testid="search-pending-line"]').hostNodes()
  return line.length ? line.text() : null
}

describe('backlog 38.3 > which combination each fan-out index is', () => {
  it('names only the own-bike + transit combination', () => {
    expect(COMBOS.map(pendingComboKind)).toEqual([
      'OTHER',
      'OTHER',
      'BICYCLE_TRANSIT'
    ])
    expect(
      pendingComboKind({
        modes: [{ mode: 'BICYCLE', qualifier: 'RENT' }, { mode: 'TRANSIT' }]
      } as any)
    ).toBe('OTHER')
    expect(
      pendingComboKind({ modes: [{ mode: 'BICYCLE' }, { mode: 'BUS' }] } as any)
    ).toBe('BICYCLE_TRANSIT')
  })
})

describe('backlog 38.3 > the reducer tracks what is still out', () => {
  it('3 pending -> 2 answered names bike + transit -> last answer clears it', () => {
    let otp = requested()
    expect(kindOf(otp)).toBe('MORE')
    otp = reducer(otp, responseAction(1)) // bike, +0.1-0.5 s
    expect(kindOf(otp)).toBe('MORE')
    otp = reducer(otp, responseAction(0)) // walk + transit, +0.4-2.8 s
    expect(otp.searches[SEARCH_ID].pending).toBe(1)
    expect(kindOf(otp)).toBe('BICYCLE_TRANSIT')
    otp = reducer(otp, responseAction(2)) // bike + transit, ~8 s
    expect(otp.searches[SEARCH_ID].pending).toBe(0)
    expect(kindOf(otp)).toBeNull()
  })

  it('an error on the pending search clears it', () => {
    let otp = requested()
    otp = reducer(otp, responseAction(0))
    otp = reducer(otp, responseAction(1))
    expect(kindOf(otp)).toBe('BICYCLE_TRANSIT')
    otp = reducer(otp, errorAction(2))
    expect(kindOf(otp)).toBeNull()
  })

  it('an error on a fast combination leaves "more" while two are out', () => {
    let otp = requested()
    otp = reducer(otp, errorAction(1))
    expect(otp.searches[SEARCH_ID].pending).toBe(2)
    expect(kindOf(otp)).toBe('MORE')
  })

  it('a pending query with no recorded combination is "more results"', () => {
    expect(getSearchPendingKind({ pending: 1 })).toBe('MORE')
    expect(getSearchPendingKind({ pending: 0 })).toBeNull()
    expect(getSearchPendingKind(null)).toBeNull()
  })
})

describe('backlog 38.3 > the results list', () => {
  it('pending > 0: the line sits at the top of the list and names bike + transit', () => {
    let otp = requested()
    otp = reducer(otp, responseAction(1))
    otp = reducer(otp, responseAction(0))
    const { wrapper } = mountList(otp)
    expect(lineText(wrapper)).toBe('Bike + transit still searching…')
    // First child of the list, ahead of every itinerary row.
    const list = wrapper.find('#itinerary-menu').hostNodes()
    expect(
      list.childAt(0).find('[data-testid="search-pending-line"]').length
    ).toBeGreaterThan(0)
    // Results already in are shown under it.
    expect(wrapper.find('li').length).toBeGreaterThan(0)
  })

  it('pending > 0 with more than bike + transit out: "More results still searching…"', () => {
    const { wrapper } = mountList(requested())
    expect(lineText(wrapper)).toBe('More results still searching…')
  })

  it('pending 0: no line', () => {
    let otp = requested()
    ;[0, 1, 2].forEach((i) => {
      otp = reducer(otp, responseAction(i))
    })
    const { wrapper } = mountList(otp)
    expect(lineText(wrapper)).toBeNull()
  })

  it('an error on the pending search: no line', () => {
    let otp = requested()
    otp = reducer(otp, responseAction(0))
    otp = reducer(otp, responseAction(1))
    otp = reducer(otp, errorAction(2))
    const { wrapper } = mountList(otp)
    expect(lineText(wrapper)).toBeNull()
  })

  if (process.env.SEARCH_PENDING_DUMP) {
    it('dumps the in-flight list for the screenshot', () => {
      let otp = requested()
      otp = reducer(otp, responseAction(1))
      otp = reducer(otp, responseAction(0))
      const { wrapper } = mountList(otp)
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('fs').writeFileSync(
        process.env.SEARCH_PENDING_DUMP as string,
        `${document.head.innerHTML}\n${wrapper.html()}`
      )
    })
  }
})
