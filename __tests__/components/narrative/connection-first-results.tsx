/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { act } from 'react-dom/test-utils'
import { ClassicLegIcon } from '@opentripplanner/icons'
import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import { Provider } from 'react-redux'
import { readFileSync } from 'fs'
import configureStore from 'redux-mock-store'

import path from 'path'

import React from 'react'
import thunk from 'redux-thunk'
import yaml from 'js-yaml'

import {
  BoardingChoice,
  CONNECTION_FIRST_STORAGE_KEY,
  groupConnections,
  isConnectionFirstEnabled,
  resetConnectionFirstFlagCache,
  setConnectionFirstEnabled
} from '../../../lib/util/connection-first'
import { collectItinerariesWithoutDuplicates } from '../../../lib/util/itinerary'
import { ComponentContext } from '../../../lib/util/contexts'
import { getMockInitialState } from '../../test-utils/mock-data/store'
import ConnectionFirstResults from '../../../lib/components/narrative/connection-first-results'
import NarrativeItineraries from '../../../lib/components/narrative/narrative-itineraries'
import responses from '../../test-utils/mock-data/0921-0912-search-responses.json'

/**
 * Backlog 21.5 — connection-first results, on the rider's own 2026-09-21
 * 09:00 search (the 09:12:07 re-plan's three responses, 45 itineraries):
 *
 *   response 0  WALK + transit   27 itineraries
 *   response 1  BICYCLE          1  (bike the whole way)
 *   response 2  BICYCLE + transit 17 (one of them bike the whole way again)
 *
 * The mock (revision 2) was drawn from the 18 bike itineraries only and
 * showed 2 boarding stations and 6 connections. That view is asserted here,
 * and so is the whole answer, which the built list shows in full.
 *
 * The suite runs in America/Los_Angeles (global-setup.js).
 */

/** Jest maps i18n/*.yml to an empty object; read the shipped English file. */
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

/** 2026-09-21 09:00 CDT — the search's own departure time. */
const SEARCH_TIME = Date.parse('2026-09-21T14:00:00Z')

function allItineraries(): any[] {
  const response = [0, 1, 2].map((i) => ({
    plan: { itineraries: (responses as any)[String(i)].itineraries }
  }))
  return (collectItinerariesWithoutDuplicates(response as any) as any[]).map(
    (itin, index) => ({ ...itin, index })
  )
}

const usesBike = (itin: any) =>
  itin.legs.some((leg: any) => leg.mode === 'BICYCLE')

const connectionCount = (choices: BoardingChoice[]) =>
  choices.reduce((n, c) => n + c.connections.length, 0)

/** Anything on screen that reads as a clock time or a duration. */
const TIME_PATTERN =
  /\d{1,2}:\d{2}|\b\d+\s*(min|mins|minutes|hr|hrs|h)\b|\b(AM|PM)\b/i

describe('backlog 21.5 > grouping the 09:12 answer by where you get on and off', () => {
  const all = allItineraries()

  it('is the 45 itineraries the rider had on screen', () => {
    expect(all).toHaveLength(45)
    expect(all.filter(usesBike)).toHaveLength(18)
  })

  it('the bike view: 2 boarding stops, 6 connections, bike the whole way kept', () => {
    const choices = groupConnections(all.filter(usesBike), SEARCH_TIME)
    const stops = choices.filter((c) => !c.direct)
    expect(stops.map((c) => c.stop?.name)).toEqual([
      'I-35W & Lake St Station',
      'Portland & 38th St Station'
    ])
    expect(choices.filter((c) => c.direct)).toHaveLength(1)
    // 5 bus connections + bike the whole way.
    expect(connectionCount(choices)).toBe(6)
    // Ordered by the arrival of each one's next departure: Lake St (9:52),
    // bike the whole way (10:12), Portland (11:44).
    expect(choices.map((c) => (c.direct ? 'bike' : c.stop?.name))).toEqual([
      'I-35W & Lake St Station',
      'bike',
      'Portland & 38th St Station'
    ])
  })

  it('merges one platform published by two agencies, and keeps the exact stops per connection', () => {
    const [lake] = groupConnections(all.filter(usesBike), SEARCH_TIME)
    // 1:17781 (Orange Line) and 2:17781 (465): code 17781, 21 m apart.
    expect(new Set(lake.connections.map((c) => c.board?.gtfsId))).toEqual(
      new Set(['1:17781', '2:17781'])
    )
    expect(
      lake.routes.map((leg: any) => leg.route.shortName || leg.route.longName)
    ).toEqual(['METRO Orange Line', '465'])
    // Four places to get off, soonest arrival first.
    expect(lake.connections.map((c) => c.alight?.name)).toEqual([
      'I-35W & 98th St Station',
      'I-35W & 98th Street Station Gate E',
      '98th St W & Penn Ave S',
      'Old Shakopee Rd & Queen Ave S'
    ])
    const arrivals = lake.connections.map((c) => c.next.endTime)
    expect([...arrivals].sort((a, b) => a - b)).toEqual(arrivals)
    // The next available departure of the first: the 9:12 Orange Line, 9:52.
    const first = lake.connections[0]
    expect(first.departures).toHaveLength(7)
    expect(first.next).toBe(first.departures[0])
    expect(new Date(first.next.endTime).toISOString().slice(0, 16)).toBe(
      '2026-09-21T14:52'
    )
    // Orange then 539 is one chain, drawn as two routes.
    expect(
      lake.connections[2].chains.map((chain) =>
        chain.map((leg: any) => leg.route.shortName || leg.route.longName)
      )
    ).toEqual([['METRO Orange Line', '539']])
  })

  it('the whole answer: every itinerary in exactly one connection, walk and bike apart', () => {
    const choices = groupConnections(all, SEARCH_TIME)
    const placed = choices.flatMap((c) =>
      c.connections.flatMap((conn) => conn.departures.map((d) => d.index))
    )
    // Departures are one per start minute, so a handful of same-minute twins
    // fold; nothing else is lost.
    expect(new Set(placed).size).toBe(placed.length)
    expect(placed.length).toBeLessThanOrEqual(45)
    const summary = choices.map(
      (c) =>
        `${c.accessMode} ${c.direct ? '(no transit)' : c.stop?.name} x${
          c.connections.length
        }`
    )
    expect(summary).toEqual([
      'BICYCLE I-35W & Lake St Station x4',
      'WALK I-35W & Lake St Station x4',
      'WALK 4th Ave S & 33rd St E x2',
      'BICYCLE (no transit) x1',
      'WALK Chicago & 34th St Station x3',
      'BICYCLE Portland & 38th St Station x1'
    ])
    expect(connectionCount(choices)).toBe(15)
    const firstArrivals = choices.map((c) => c.connections[0].next.endTime)
    expect([...firstArrivals].sort((a, b) => a - b)).toEqual(firstArrivals)
  })

  it('takes the next departure the rider can still make', () => {
    const at = (now: number) =>
      groupConnections(all.filter(usesBike), now)[0].connections.find(
        (c) => c.alight?.gtfsId === '1:56833'
      )
    const fresh = at(SEARCH_TIME)
    const later = at(SEARCH_TIME + 20 * 60000)
    expect(fresh?.next.index).toBe(fresh?.departures[0].index)
    // At 09:20 the 9:12 Orange Line (leave home 9:05) has gone; the 9:36 is
    // next, and the list re-orders on it.
    expect(later?.next.index).toBe(later?.departures[1].index)
  })
})

// ---------------------------------------------------------------------------

function mountList(
  choices: BoardingChoice[],
  renderItinerary = jest.fn(() => <div className="chosen-itin" />)
) {
  const store = configureStore([thunk])(getMockInitialState())
  const wrapper = mount(
    <IntlProvider defaultLocale="en-US" locale="en-US" messages={messages}>
      <Provider store={store}>
        <ConnectionFirstResults
          choices={choices}
          onShow={jest.fn()}
          renderItinerary={renderItinerary}
        />
      </Provider>
    </IntlProvider>
  )
  return { renderItinerary, wrapper }
}

describe('backlog 21.5 > no times until both stops are chosen', () => {
  const choices = groupConnections(allItineraries(), SEARCH_TIME)
  const bikeLake = choices.findIndex(
    (c) => c.accessMode === 'BICYCLE' && c.stop?.code === '17781'
  )

  it('screen 1 names boarding stops, distances and routes, and no time at all', () => {
    const { wrapper } = mountList(choices)
    const text = wrapper.text()
    expect(text).toContain('Where do you get on?')
    expect(text).toContain('I-35W & Lake St Station')
    expect(text).toContain('Bike the whole way')
    expect(text).toMatch(/Bike [\d.]+ miles to get here/)
    expect(text).toContain('4 places to get off')
    expect(text).not.toMatch(TIME_PATTERN)
    expect(wrapper.find('button.board-card')).toHaveLength(6)
  })

  it('screen 2 lists the get-off stops from the chosen one, still with no time', () => {
    const { renderItinerary, wrapper } = mountList(choices)
    wrapper.find('button.board-card').at(bikeLake).simulate('click')
    const text = wrapper.text()
    expect(text).toContain('Where do you get off?')
    expect(text).toContain('I-35W & 98th Street Station Gate E')
    expect(text).toMatch(/Then bike [\d.]+ miles to your destination/)
    expect(text).not.toMatch(TIME_PATTERN)
    expect(wrapper.find('button.off-card')).toHaveLength(4)
    expect(renderItinerary).not.toHaveBeenCalled()
  })

  it('screen 3 opens the chosen connection on its next departure, with its own departures as chips', () => {
    const { renderItinerary, wrapper } = mountList(choices)
    wrapper.find('button.board-card').at(bikeLake).simulate('click')
    wrapper.find('button.off-card').at(0).simulate('click')
    const lake = choices[bikeLake]
    const first = lake.connections[0]
    expect(renderItinerary).toHaveBeenCalled()
    const [itinerary, onChoose] = (renderItinerary.mock.calls as any[]).slice(
      -1
    )[0]
    expect(itinerary.index).toBe(first.next.index)
    expect(itinerary.allStartTimes.map((t: any) => t.itinerary.index)).toEqual(
      first.departures.map((d) => d.index)
    )
    // A chip picks another of the same connection's buses.
    act(() => onChoose({ index: first.departures[2].index }))
    wrapper.update()
    const [again] = (renderItinerary.mock.calls as any[]).slice(-1)[0]
    expect(again.index).toBe(first.departures[2].index)
    // "Change" on the get-off line goes back to screen 2.
    wrapper.find('.connection-first-times button').at(1).simulate('click')
    expect(wrapper.find('button.off-card')).toHaveLength(4)
  })

  it('bike the whole way goes straight to its trip', () => {
    const { renderItinerary, wrapper } = mountList(choices)
    const bikeIndex = choices.findIndex((c) => c.direct)
    wrapper.find('button.board-card').at(bikeIndex).simulate('click')
    expect(renderItinerary).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.connection-first-times')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

describe('backlog 21.5 > the flag', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetConnectionFirstFlagCache()
    window.history.replaceState({}, '', '/')
  })

  it('is off unless the rider turned it on', () => {
    expect(isConnectionFirstEnabled()).toBe(false)
    setConnectionFirstEnabled(true)
    resetConnectionFirstFlagCache()
    expect(isConnectionFirstEnabled()).toBe(true)
    expect(
      JSON.parse(
        window.localStorage.getItem(`otp.${CONNECTION_FIRST_STORAGE_KEY}`) || ''
      )
    ).toEqual({ enabled: true })
  })

  it('can be set from the URL', () => {
    window.history.replaceState({}, '', '/?connectionFirst=1')
    expect(isConnectionFirstEnabled()).toBe(true)
  })

  function mountNarrative() {
    const state: any = getMockInitialState()
    state.otp.config.itinerary = {
      groupByMode: true,
      mergeByRouteSignature: true,
      mergeItineraries: true
    }
    state.otp.activeSearchId = 'a'
    state.otp.searches = {
      a: {
        activeItinerary: -1,
        pending: 0,
        query: {
          from: { lat: 44.9426, lon: -93.264, name: 'Home' },
          to: { lat: 44.8165, lon: -93.3099, name: '2345 Old Shakopee Rd W' }
        },
        response: [0, 1, 2].map((i) => ({
          plan: { itineraries: (responses as any)[String(i)].itineraries }
        }))
      }
    }
    const store = configureStore([thunk])(state)
    const StubRow = ({ itinerary }: any) => (
      <div className="stub-row">{itinerary.index}</div>
    )
    return mount(
      <IntlProvider defaultLocale="en-US" locale="en-US" messages={messages}>
        <Provider store={store}>
          <ComponentContext.Provider
            value={{ ItineraryBody: StubRow, LegIcon: ClassicLegIcon }}
          >
            <NarrativeItineraries />
          </ComponentContext.Provider>
        </Provider>
      </IntlProvider>
    )
  }

  it('off: today’s list, untouched', () => {
    const wrapper = mountNarrative()
    expect(wrapper.find('.connection-first')).toHaveLength(0)
    expect(wrapper.find('.stub-row').length).toBeGreaterThan(0)
  })

  it('on: the connection-first list instead, and no result row until both stops are chosen', () => {
    setConnectionFirstEnabled(true)
    const wrapper = mountNarrative()
    expect(wrapper.find('.connection-first')).toHaveLength(1)
    expect(wrapper.find('.stub-row')).toHaveLength(0)
    expect(wrapper.find('button.board-card')).toHaveLength(6)
  })
})
