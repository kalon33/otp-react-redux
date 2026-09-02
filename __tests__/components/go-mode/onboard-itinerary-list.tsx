import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import { ComponentContext } from '../../../lib/util/contexts'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import OnboardItineraryList from '../../../lib/components/go-mode/OnboardItineraryList'

/**
 * Jest maps i18n/*.yml to an empty object, so the drill-down's messages (which
 * carry no defaultMessage — they are MetroUI's, shared with the planner) would
 * render as ids. Read the shipped English file instead, so the copy asserted
 * here is the copy that reaches the phone.
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

const MIN = 60000
const T = 1700000000000

/** Stands in for the app's ItineraryBody: enough to tell the rows apart. */
const StubItineraryBody = ({ itinerary }: any) => (
  <div className="stub-itin">
    {itinerary.legs
      .filter((l: any) => l.transitLeg)
      .map((l: any) => l.routeId)
      .join(' > ')}
  </div>
)

/** An onboard alight option whose displayed trip rides `routes` in order. */
const option = (
  stopName: string,
  routes: string[],
  { bikeAfter = 400, endTime = T + 30 * MIN, hopMeters = 5000 } = {}
) => ({
  busArrivalEpoch: T,
  displayItinerary: {
    endTime,
    legs: [
      ...routes.map((routeId, i) => ({
        distance: i === routes.length - 1 ? hopMeters : 5000,
        mode: 'BUS',
        routeId,
        transitLeg: true
      })),
      { distance: bikeAfter, mode: 'BICYCLE', transitLeg: false }
    ],
    startTime: T
  },
  itinerary: { legs: [] },
  realtime: true,
  stopId: `s:${stopName}`,
  stopName
})

function renderList(options: any[], onSelect = jest.fn()) {
  const state = getMockInitialState()
  // The component is rendered through ComponentContext's ItineraryBody, the
  // same way the real narrative list is.
  const Wrapped = (props: any) => (
    <ComponentContext.Provider
      value={{ ItineraryBody: StubItineraryBody, LegIcon: () => null } as any}
    >
      <OnboardItineraryList {...props} />
    </ComponentContext.Provider>
  )
  const { wrapper } = mockWithProvider(
    Wrapped,
    { onSelect, options },
    state,
    messages
  )
  return { onSelect, wrapper }
}

/**
 * Rider ask #44, 2026-08-27: *"on the already on the bus search they aren't
 * stacked, just a list of the same routes."* The planner has stacked
 * same-shape trips since `0d37eed2`; this is the onboard path doing the same.
 */
describe('components > go-mode > OnboardItineraryList', () => {
  describe('stacking same-route options (rider ask #44)', () => {
    const sameChain = [
      option('98th St', ['1:539', '1:465']),
      option('Nicollet', ['1:539', '1:465']),
      option('Burnsville', ['1:539', '1:465'])
    ]

    it('renders one row for three options riding the same routes', () => {
      const { wrapper } = renderList(sameChain)
      expect(wrapper.find('li.result')).toHaveLength(1)
      expect(wrapper.text()).toContain('Off at 98th St')
    })

    it('offers the planner’s own drill-down back to the others', () => {
      const { wrapper } = renderList(sameChain)
      const toggle = wrapper.find('button.same-shape-variants-toggle')
      expect(toggle).toHaveLength(1)
      expect(toggle.text()).toBe('3 options')
    })

    it('names the alight stop on each variant — that is the choice', () => {
      const { wrapper } = renderList(sameChain)
      wrapper.find('button.same-shape-variants-toggle').simulate('click')
      const text = wrapper.text()
      expect(text).toContain('Nicollet')
      expect(text).toContain('Burnsville')
    })

    it('starts guidance to the variant the rider picks, not the row', () => {
      const { onSelect, wrapper } = renderList(sameChain)
      wrapper.find('button.same-shape-variants-toggle').simulate('click')
      wrapper.find('button[data-index=2]').simulate('click')
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect.mock.calls[0][0].stopName).toBe('Burnsville')
    })

    it('opening the drill-down does not choose the row', () => {
      const { onSelect, wrapper } = renderList(sameChain)
      wrapper.find('button.same-shape-variants-toggle').simulate('click')
      expect(onSelect).not.toHaveBeenCalled()
    })

    it('still starts guidance when the row itself is tapped', () => {
      const { onSelect, wrapper } = renderList(sameChain)
      wrapper.find('div.stub-itin').simulate('click')
      expect(onSelect).toHaveBeenCalledTimes(1)
      expect(onSelect.mock.calls[0][0].stopName).toBe('98th St')
    })

    it('leaves genuinely different journeys as separate rows', () => {
      const { wrapper } = renderList([
        option('98th St', ['1:539', '1:465']),
        option('Mall', ['1:Orange'])
      ])
      expect(wrapper.find('li.result')).toHaveLength(2)
      expect(wrapper.find('button.same-shape-variants-toggle')).toHaveLength(0)
    })
  })

  // The 2026-08-31 602 m hop, on the onboard path this time. Ordering only —
  // the hop option is still there, one row down.
  describe('token transit hops', () => {
    it('ranks the same journey without the two-block hop first', () => {
      const { wrapper } = renderList([
        option('98th & Dupont', ['1:Orange', '1:539'], {
          bikeAfter: 1743,
          endTime: T + 30 * MIN,
          hopMeters: 602
        }),
        option('Mall', ['1:Orange'], {
          bikeAfter: 3970,
          endTime: T + 33 * MIN
        })
      ])
      const rows = wrapper.find('li.result')
      expect(rows).toHaveLength(2)
      expect(rows.at(0).text()).toContain('Off at Mall')
      expect(rows.at(1).text()).toContain('Off at 98th & Dupont')
    })
  })
})
