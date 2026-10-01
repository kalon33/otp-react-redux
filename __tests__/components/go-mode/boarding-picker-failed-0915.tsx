import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import BoardingPrompt from '../../../lib/components/go-mode/BoardingPrompt'

/** Jest maps i18n/*.yml to {}, so read the shipped English copy. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

/** Vehicle 8140's confirmed match, from the 2026-09-15 ride. */
const MATCH_8140 = {
  confidence: 'confirmed',
  distanceMeters: 19,
  label: 'ORANGE Downtown Minneapolis',
  lastSeen: 1789505102000,
  nextStopId: '1:48084',
  routeId: '1:904',
  tripId: '1:1346665',
  vehicleId: '1:8140'
}

const NEARBY_8140 = {
  distanceMeters: 151.7,
  label: '8140',
  nextStopId: '1:48084',
  nextStopName: 'I-35W & 66th St Station',
  routeId: '1:904',
  routeName: 'METRO Orange Line',
  tripHeadsign: 'ORANGE Downtown Minneapolis',
  tripId: '1:1346665',
  vehicleId: '1:8140'
}

function render({
  match = MATCH_8140,
  nearbyVehicles = [] as unknown[],
  searchFailed = false,
  searching = false
} = {}) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(state.otp as any).goMode = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...((state.otp as any).goMode || {}),
    activeItinerary: {
      legs: [
        {
          mode: 'BUS',
          routeLongName: 'METRO Orange Line',
          routeShortName: null,
          transitLeg: true
        }
      ]
    },
    alightedFrom: null,
    boardingPrompt: {
      lastDismissedAt: null,
      searchFailed,
      searching,
      shown: true,
      transitLegEnteredAt: null
    },
    isActive: true,
    onboard: {
      alightOptions: [],
      answeredCandidates: null,
      bestAlightStop: null,
      candidates: [],
      keepRouteId: null,
      pendingCandidates: null,
      status: 'awaiting-selection',
      trip: null,
      vehicle: null
    },
    riding: null,
    routeMatch: { legIndex: 0 },
    vehicleMatch: { match, nearbyVehicles }
  }
  return mockWithProvider(BoardingPrompt, {}, state, messages)
}

/**
 * 17.5. The 2026-09-15 15:47:25 screenshot: header "On the bus", an entirely
 * blank body, the prompt "Which bus are you on? Pick it below." and zero rows,
 * while `FIND_TRIP_ERROR` and five `REALTIME_VEHICLE_POSITIONS_ERROR`s were
 * landing, all "Request timed out after 20000 ms" (17.8) — and Go Mode was
 * holding trip 1:1346665 / vehicle 1:8140 underneath the whole time.
 *
 * Second sighting: the first is written up in source at
 * util/go-mode/alight-optimizer.ts:618 (2026-08-31, an empty panel for 9m11s,
 * "no state anywhere said the search had failed").
 */
describe('components > go-mode > BoardingPrompt, a search that failed', () => {
  it('says the feed could not be reached instead of "No buses detected nearby"', () => {
    // FAILS BEFORE: body 'none', i.e. a statement about the street for a
    // request that never returned.
    const { wrapper } = render({ searchFailed: true })

    expect(
      wrapper.find('[data-testid="boarding-search-failed"]').exists()
    ).toBe(true)
    expect(wrapper.text()).toContain("Couldn't reach the bus feed")
    expect(wrapper.text()).not.toContain('No buses detected nearby')
  })

  it('offers a retry', () => {
    // FAILS BEFORE: the only controls on the sheet were "Not yet" and the
    // per-vehicle "This one" — with no vehicles, nothing to tap at all.
    const { wrapper } = render({ searchFailed: true })

    expect(wrapper.find('[data-testid="boarding-retry"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Try again')
  })

  it('offers the bus it has already confirmed, named', () => {
    const { wrapper } = render({ searchFailed: true })

    expect(
      wrapper.find('[data-testid="boarding-known-vehicle"]').exists()
    ).toBe(true)
    expect(wrapper.text()).toContain('ORANGE Downtown Minneapolis')
    // The rider reads the number off the bus, not the feed prefix.
    expect(wrapper.text()).toContain('#8140')
    expect(wrapper.text()).not.toContain('1:8140')
  })

  it('does not offer the same bus twice', () => {
    // The app knowing the vehicle is why the row exists; showing it beside an
    // identical search result would be the redundant prompt the rider's
    // standing rule forbids.
    const { wrapper } = render({ nearbyVehicles: [NEARBY_8140] })

    expect(
      wrapper.find('[data-testid="boarding-known-vehicle"]').exists()
    ).toBe(false)
    expect(wrapper.text()).toContain('METRO Orange Line')
  })

  it('shows neither the failure nor a retry while the search is still running', () => {
    const { wrapper } = render({ searchFailed: true, searching: true })

    expect(wrapper.text()).toContain('Looking')
    expect(wrapper.find('[data-testid="boarding-retry"]').exists()).toBe(false)
    expect(
      wrapper.find('[data-testid="boarding-search-failed"]').exists()
    ).toBe(false)
  })

  it('has nothing to offer when the app knows of no vehicle either', () => {
    const { wrapper } = render({ match: null, searchFailed: true })

    expect(
      wrapper.find('[data-testid="boarding-known-vehicle"]').exists()
    ).toBe(false)
    expect(wrapper.text()).toContain("Couldn't reach the bus feed")
    expect(wrapper.text()).toContain('Try again')
  })
})
