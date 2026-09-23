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
  {
    alightStopName,
    bikeAfter = 400,
    endTime = T + 30 * MIN,
    hopMeters = 5000
  }: {
    alightStopName?: string
    bikeAfter?: number
    endTime?: number
    hopMeters?: number
  } = {}
) => ({
  ...(alightStopName
    ? { alightStopId: `s:${alightStopName}`, alightStopName }
    : {}),
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

function renderList(
  options: any[],
  onPreview = jest.fn(),
  onPreviewVariant = jest.fn()
) {
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
    { onPreview, onPreviewVariant, options },
    state,
    messages
  )
  return { onPreview, onPreviewVariant, wrapper }
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
      // Three places to get off: the control says "Other stops" and nothing
      // else (21.5, 2026-09-23: "description on button is just other stops").
      expect(toggle.text()).toBe('Other stops▶')
    })

    it('names the alight stop on each variant — that is the choice', () => {
      const { wrapper } = renderList(sameChain)
      wrapper.find('button.same-shape-variants-toggle').simulate('click')
      const text = wrapper.text()
      expect(text).toContain('Nicollet')
      expect(text).toContain('Burnsville')
    })

    it('previews the variant the rider picks, not the row', () => {
      const { onPreview, onPreviewVariant, wrapper } = renderList(sameChain)
      wrapper.find('button.same-shape-variants-toggle').simulate('click')
      // Own pair (98th St) first, then Nicollet, then Burnsville.
      wrapper.find('button[data-pair]').at(2).simulate('click')
      expect(onPreviewVariant).toHaveBeenCalledTimes(1)
      expect(onPreviewVariant.mock.calls[0][0].stopName).toBe('Burnsville')
      // The drill-down pick is a VIEW, never the commit it used to be (17.1).
      expect(onPreview).not.toHaveBeenCalled()
    })

    it('opening the drill-down does not choose the row', () => {
      const { onPreview, onPreviewVariant, wrapper } = renderList(sameChain)
      wrapper.find('button.same-shape-variants-toggle').simulate('click')
      expect(onPreview).not.toHaveBeenCalled()
      expect(onPreviewVariant).not.toHaveBeenCalled()
    })

    it('previews the row when the row itself is tapped', () => {
      const { onPreview, wrapper } = renderList(sameChain)
      wrapper.find('div.stub-itin').simulate('click')
      expect(onPreview).toHaveBeenCalledTimes(1)
      expect(onPreview.mock.calls[0][0].stopName).toBe('98th St')
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

  /**
   * 6.44, live 2026-09-02: the second row said "Off at I-35W & Lake St Station"
   * and guidance rode on to 1:56830, Burnsville Heart of the City — the end of
   * the line. The tap wiring was innocent (it passes the option it captions,
   * proven above); the option's `stopName` was the stop its ONWARD plan was
   * planned from, and that plan opened with the boarded trip continuing, so
   * mergeAdjacentSameTripLegs folded it into one longer ride. decorateAlightOptions
   * records the real end as `alightStopName`; the row must print THAT.
   *
   * The five options and three rows are the live shapes from the reproduction.
   */
  describe('options whose ride runs past their planning anchor', () => {
    const liveShape = [
      option('Marquette Ave & 7th St - Stop Group C', ['1:904', '2:465']),
      option('I-35W & Lake St Station', ['1:904'], {
        alightStopName: 'Burnsville Heart of the City Station'
      }),
      option('I-35W & 46th St Station', ['1:904'], {
        alightStopName: 'Burnsville Heart of the City Station'
      }),
      option('Burnsville Heart of the City Station', ['1:904', '2:425']),
      option('Gateway Ramp Layover', ['1:904', '2:465'])
    ]

    it('captions the row with the stop the ride reaches, not the anchor', () => {
      const { wrapper } = renderList(liveShape)
      const rows = wrapper.find('li.result')
      expect(rows).toHaveLength(3)
      expect(rows.at(1).text()).toContain(
        'Off at Burnsville Heart of the City Station'
      )
      expect(rows.at(1).text()).not.toContain('I-35W & Lake St Station')
    })

    it('previews the stop the tapped row names', () => {
      const { onPreview, wrapper } = renderList(liveShape)
      const rows = wrapper.find('li.result')
      rows.at(1).find('div.stub-itin').simulate('click')
      expect(onPreview).toHaveBeenCalledTimes(1)
      const chosen = onPreview.mock.calls[0][0]
      expect(chosen.alightStopName).toBe('Burnsville Heart of the City Station')
      expect(rows.at(1).text()).toContain(`Off at ${chosen.alightStopName}`)
    })

    it('offers no "Other stops" when both options really get off at the same stop', () => {
      // Lake St and 46th St are only where the two onward plans were
      // PLANNED from; both rides actually end at Burnsville Heart of the City
      // (alightStopName). Named by the real stop they are one get-on / get-off
      // pair, and a drill-down listing Burnsville twice is the "clarify if
      // there are no options" the rider asked not to see (21.5).
      const { wrapper } = renderList(liveShape)
      expect(
        wrapper
          .find('li.result')
          .at(1)
          .find('button.same-shape-variants-toggle')
      ).toHaveLength(0)
    })

    it('names the real get-off stop in the drill-down when there is a choice', () => {
      const { wrapper } = renderList([
        option('I-35W & Lake St Station', ['1:904'], {
          alightStopName: 'Burnsville Heart of the City Station'
        }),
        option('I-35W & 98th St Station', ['1:904'])
      ])
      wrapper.find('button.same-shape-variants-toggle').simulate('click')
      const pairs = wrapper.find('button[data-pair]')
      expect(pairs).toHaveLength(2)
      expect(pairs.at(0).text()).toContain(
        'OffBurnsville Heart of the City Station'
      )
      expect(pairs.at(1).text()).toContain('OffI-35W & 98th St Station')
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
