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
 * 70.4 (cycle 37 Q1 = A): a results row shows the wait between buses next to
 * the walk / bike time ("... · 6 min wait"), only when there is a minute or
 * more of it. Harness from route-lock-none-note.tsx; fixture: the 09-21 09:12
 * search's walk + transit response (index 0): [0] two buses, OTP waitingTime
 * 465 s; [2] one bus, waitingTime 0.
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

const SEARCH_ID = 'search-58-2'
// The combinations as routingQuery builds them for walk + transit, bike,
// bike + transit.
const COMBOS = [{ modes: [{ mode: 'TRANSIT' }, { mode: 'WALK' }] }]

const reducer = createOtpReducer({})

const responseAction = (itineraries: any[]) => ({
  payload: {
    index: 0,
    response: {
      plan: { itineraries },
      requestId: SEARCH_ID
    },
    searchId: SEARCH_ID
  },
  type: 'ROUTING_RESPONSE'
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

const all: any[] = (responses as any)['0'].itineraries
const twoBus = () => clone(all[0])
const oneBus = () => clone(all[2])

const detailsText = (wrapper: any) => wrapper.find('li.result').first().text()

const rowFor = (itinerary: any) => {
  const otp = reducer(requested(), responseAction([itinerary]))
  return mountList(otp).wrapper
}

describe('70.4 > wait between buses on the route row', () => {
  it('a transfer trip shows the wait next to the walk time', () => {
    const itin = twoBus()
    expect(itin.waitingTime).toBe(465)
    expect(itin.legs.filter((l: any) => l.transitLeg)).toHaveLength(2)
    const text = detailsText(rowFor(itin))
    expect(text).toMatch(/walking · 7 min\s+wait/)
  })

  it('a one-bus trip shows no wait', () => {
    const itin = oneBus()
    expect(itin.waitingTime).toBe(0)
    const text = detailsText(rowFor(itin))
    expect(text).toContain('walking')
    expect(text).not.toContain('wait')
  })

  it('under a minute of wait shows nothing', () => {
    const itin = twoBus()
    itin.waitingTime = 59
    expect(detailsText(rowFor(itin))).not.toContain('wait')
  })

  it('exactly a minute shows "1 min wait"', () => {
    const itin = twoBus()
    itin.waitingTime = 60
    expect(detailsText(rowFor(itin))).toMatch(/· 1 min\s+wait/)
  })

  it('beside the bike time when the trip has a bike leg', () => {
    const itin = twoBus()
    itin.legs[0] = { ...itin.legs[0], duration: 720, mode: 'BICYCLE' }
    expect(detailsText(rowFor(itin))).toMatch(/12 min\s+biking · 7 min\s+wait/)
  })
})
