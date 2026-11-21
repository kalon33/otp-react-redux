/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import { ClassicLegIcon, ClassicModeIcon } from '@opentripplanner/icons'
import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import React from 'react'
import yaml from 'js-yaml'

import {
  buildExploreVariant,
  explorePlanFor
} from '../../../lib/util/bike-explore-variants'
import { ComponentContext } from '../../../lib/util/contexts'
import {
  exploreDirectLeaveMs,
  exploreItineraryKey
} from '../../../lib/util/bike-explore'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { pendingComboKind } from '../../../lib/actions/api-utils'
import BikeExploreSwitch from '../../../lib/components/narrative/bike-explore-switch'
import createOtpReducer from '../../../lib/reducers/create-otp-reducer'
import engine from '../../test-utils/mock-data/bike-explore-0923-1537.json'
import ExploreRideDetails from '../../../lib/components/narrative/metro/explore-ride-details'
import MetroItinerary from '../../../lib/components/narrative/metro/metro-itinerary'
import NarrativeItineraries from '../../../lib/components/narrative/narrative-itineraries'
import recorded from '../../test-utils/mock-data/other-stops-0923-1537.json'
import responses from '../../test-utils/mock-data/0921-0912-search-responses.json'

/**
 * Backlog 76.2 on screen: the Direct | Calm | Wander switch at the top of the
 * results, and what a Calm / Wander card adds. Harness from
 * route-row-wait.tsx (the shipped list config, MetroItinerary rows). Real
 * shapes: the 2026-09-23 15:37 Orange Line representative and its run, the
 * engine's captured answers for it, and the 09-21 09:12 search's walk + transit
 * and bike-only itineraries.
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

const rec = recorded as any
const eng = engine as any
const search = responses as any
const clone = (x: any) => JSON.parse(JSON.stringify(x))
const SEARCH_ID = 'search-76-2'
const COMBOS = [{ modes: [{ mode: 'BICYCLE' }, { mode: 'TRANSIT' }] }]
const reducer = createOtpReducer({})
const g = global as any

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

/** A settled search holding these itineraries, as the reducer stores it. */
function searched(itineraries: any[]) {
  const base = getMockInitialState().otp
  base.currentQuery.from = rec.from
  base.currentQuery.to = rec.to
  base.transitIndex.trips = { [rec.trip.id]: rec.trip }
  const requested = reducer(base, {
    payload: {
      activeItinerary: null,
      pending: COMBOS.length,
      pendingCombos: COMBOS.map(pendingComboKind),
      searchId: SEARCH_ID
    },
    type: 'ROUTING_REQUEST'
  })
  return reducer(requested, {
    payload: {
      index: 0,
      response: { plan: { itineraries }, requestId: SEARCH_ID },
      searchId: SEARCH_ID
    },
    type: 'ROUTING_RESPONSE'
  })
}

/** The representative's Wander variant, as the action stores it. */
function wanderVariant() {
  const itinerary = clone(rec.representative)
  return buildExploreVariant({
    itinerary,
    mode: 'wander',
    nowMs: eng.access.nowMs,
    plan: explorePlanFor(itinerary, rec.trip, rec.from),
    results: eng.access.wander.candidates,
    trip: rec.trip
  }) as any
}

function withExplore(otp: any, mode: string, entries?: any) {
  return {
    ...otp,
    bikeExplore: {
      ...otp.bikeExplore,
      mode,
      searches: entries ? { [SEARCH_ID]: { [mode]: entries } } : {}
    }
  }
}

function mountList(otp: any) {
  const state = getMockInitialState()
  const full = {
    ...otp,
    config: {
      ...otp.config,
      homeTimezone: 'America/Chicago',
      itinerary: { ...otp.config?.itinerary, ...SHIPPED_ITINERARY_CONFIG }
    }
  }
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
  return mockWithProvider(List, {}, { ...state, otp: full }, messages)
}

const rowsText = (wrapper: any) =>
  wrapper.find('li.result').map((row: any) => row.text())

beforeEach(() => {
  g.fetch = jest.fn(async () => ({
    json: async () => eng.access.wander,
    ok: true
  }))
})
afterEach(() => {
  delete g.fetch
})

describe('76.2 > the Direct | Calm | Wander switch', () => {
  it('sits at the top of a result list that has a bike ride, Direct chosen', () => {
    const { wrapper } = mountList(searched([clone(rec.representative)]))
    const group = wrapper.find('[role="radiogroup"]').hostNodes()
    expect(group).toHaveLength(1)
    expect(group.prop('aria-label')).toBe('Bike route')
    const radios = group.find('[role="radio"]').hostNodes()
    expect(radios.map((r: any) => r.text())).toEqual([
      'Direct',
      'Calm',
      'Wander'
    ])
    expect(radios.map((r: any) => r.prop('aria-checked'))).toEqual([
      true,
      false,
      false
    ])
    // Roving tab stop on the chosen one.
    expect(radios.map((r: any) => r.prop('tabIndex'))).toEqual([0, -1, -1])
  })

  it('is not there when no result starts on a bike', () => {
    const walk = clone(search['0'].itineraries[2])
    const { wrapper } = mountList(searched([walk]))
    expect(wrapper.find('.bike-explore-switch').hostNodes()).toHaveLength(0)
  })

  it('Direct asks the engine nothing', () => {
    const { store } = mountList(searched([clone(rec.representative)]))
    expect(g.fetch).not.toHaveBeenCalled()
    expect(
      store.getActions().filter((a: any) => /BIKE_EXPLORE/.test(a.type))
    ).toEqual([])
  })

  it('a tap or an arrow key chooses a mode', () => {
    const { store, wrapper } = mountList(searched([clone(rec.representative)]))
    wrapper.find('button.bike-explore-wander').simulate('click')
    wrapper
      .find('[role="radiogroup"]')
      .hostNodes()
      .simulate('keydown', { key: 'ArrowRight' })
    expect(
      store
        .getActions()
        .filter((a: any) => a.type === 'SET_BIKE_EXPLORE_MODE')
        .map((a: any) => a.payload)
    ).toEqual(['wander', 'calm'])
  })

  it('in Calm or Wander asks for the rides it does not have, and says so while out', async () => {
    const otp = searched([clone(rec.representative)])
    const key = exploreItineraryKey(rec.representative)
    const { wrapper } = mountList(
      withExplore(otp, 'wander', { [key]: { status: 'pending' } })
    )
    expect(wrapper.find('.bike-explore-loading').hostNodes().text()).toBe(
      'Finding scenic rides…'
    )
    // Already pending: nothing asked again.
    await Promise.resolve()
    expect(g.fetch).not.toHaveBeenCalled()

    const fresh = mountList(withExplore(otp, 'wander'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(g.fetch).toHaveBeenCalledTimes(1)
    expect(
      fresh.store
        .getActions()
        .filter((a: any) => a.type === 'BIKE_EXPLORE_VARIANTS').length
    ).toBeGreaterThan(0)
  })
})

describe('76.2 > the card', () => {
  it('a Wander card shows the ride: calm share, what it passes, the strip, both leave-by times, the stop', () => {
    const otp = searched([clone(rec.representative)])
    const variant = wanderVariant()
    const key = exploreItineraryKey(rec.representative)
    const { wrapper } = mountList(
      withExplore(otp, 'wander', { [key]: { status: 'done', variant } })
    )
    const [text] = rowsText(wrapper)
    expect(text).toContain('100% calm')
    expect(text).toContain('via Penn Lake')
    const directLeave = exploreDirectLeaveMs(variant) as number
    const time = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric'
    }).format(directLeave)
    expect(text).toMatch(new RegExp(`direct: leave ${time} · 1[67] min`))
    // Knox & American Blvd: OSM maps a shelter, a bench and a light.
    expect(text).toContain('stop: shelter, bench, lit')
    // You leave = this ride's start.
    const leave = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric'
    }).format(variant.startTime)
    expect(text).toContain(leave)
    const strip = wrapper.find('.explore-strip').hostNodes()
    expect(strip.prop('role')).toBe('img')
    expect(strip.prop('aria-label')).toMatch(
      /^Street stress along the ride: \d+% calm streets, \d+% busier streets, \d+% heavy traffic, \d+% walking the bike$/
    )
    expect(strip.find('span').length).toBeGreaterThan(0)
  })

  it('Direct shows the old card, word for word, whatever is stored', () => {
    const otp = searched([clone(rec.representative)])
    const key = exploreItineraryKey(rec.representative)
    const stored = withExplore(otp, 'direct')
    stored.bikeExplore.searches = {
      [SEARCH_ID]: {
        wander: { [key]: { status: 'done', variant: wanderVariant() } }
      }
    }
    const before = rowsText(mountList(otp).wrapper)
    const after = rowsText(mountList(stored).wrapper)
    expect(after).toEqual(before)
    expect(after[0]).not.toContain('calm')
    expect(
      mountList(stored).wrapper.find('.explore-ride').hostNodes()
    ).toHaveLength(0)
  })

  const mountDetails = (itinerary: any, nicest = false) =>
    mount(
      <IntlProvider defaultLocale="en-US" locale="en-US" messages={messages}>
        <ExploreRideDetails itinerary={itinerary} nicest={nicest} />
      </IntlProvider>
    )

  it('marks the nicest ride', () => {
    expect(mountDetails(wanderVariant(), true).text()).toMatch(
      /^Nicest ride100% calm/
    )
    expect(mountDetails(wanderVariant()).text()).not.toContain('Nicest')
  })

  it('says nothing about a stop OpenStreetMap does not map', () => {
    const variant = wanderVariant()
    variant.legs[0].exploreRide.stop = {
      ...variant.legs[0].exploreRide.stop,
      bench: false,
      lit: false,
      mapped: false,
      shelter: false
    }
    const text = mountDetails(variant).text()
    expect(text).toContain('direct: leave')
    expect(text).not.toContain('stop:')
    expect(text).not.toMatch(/shelter|bench|lit|no /)
  })

  it('a bike-only ride: no stop to describe, the direct ride by length', () => {
    const itinerary = clone(search['1'].itineraries[0])
    const variant = buildExploreVariant({
      itinerary,
      mode: 'calm',
      nowMs: eng.bikeOnly.nowMs,
      plan: explorePlanFor(itinerary, null, rec.from),
      results: eng.bikeOnly.calm.candidates
    })
    const text = mountDetails(variant).text()
    expect(text).toContain('100% calm')
    expect(text).not.toContain('stop:')
    expect(text).not.toMatch(/shelter|bench|lit/)
    // No bus to leave for: the direct ride's length only.
    expect(text).toMatch(/direct: 5\d min/)
    expect(text).not.toContain('leave')
    // Even were the destination a mapped stop, there is no wait there.
    const mapped: any = clone(variant)
    mapped.legs[0].exploreRide.stop = { mapped: true, shelter: true }
    expect(mountDetails(mapped).text()).not.toContain('stop:')
  })

  it('renders nothing for an itinerary OTP planned', () => {
    expect(mountDetails(clone(rec.representative)).html()).toBeFalsy()
  })
})

describe('76.2 > the switch on its own', () => {
  it('renders nothing during a Go Mode trip', () => {
    const otp = searched([clone(rec.representative)])
    otp.goMode = { ...otp.goMode, isActive: true }
    const state = getMockInitialState()
    const { wrapper } = mockWithProvider(
      BikeExploreSwitch,
      {},
      { ...state, otp },
      messages
    )
    expect(wrapper.find('[role="radiogroup"]').hostNodes()).toHaveLength(0)
  })
})
