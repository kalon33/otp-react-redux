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
import Stop, {
  fullTimestamp,
  patternArrayforStops
} from '../../../lib/components/viewers/nearby/stop'

/**
 * Builds a StopData object whose stoptimesForPatterns carry a real
 * pattern.route.gtfsId (the shape the live OTP2 GraphQL `nearest` query
 * returns), while leaving `stopRoutes` absent — exactly what the server
 * sends when it does not populate the service-date-scoped routes list
 * (e.g. older OTP builds or an unset onlyShowCurrentServiceWeek).
 *
 * This is the regression that hid every departure inside the map stop
 * popup: nearbyRoutes became [undefined] (truthy, but contains no route
 * ids), so the nearbyRoutes filter in renderPatternRows matched nothing
 * and returned an empty fragment for every pattern.
 */
function makeStopData(overrides = {}) {
  return {
    __typename: 'Stop',
    code: '100',
    gtfsId: '1:IDFM:100',
    lat: 48.8,
    lon: 2.3,
    name: 'Test Stop',
    stoptimesForPatterns: [
      {
        pattern: {
          desc: 'Test Pattern',
          headsign: 'Downtown',
          route: {
            agency: { gtfsId: '1:IDFM', name: 'Test Agency' },
            color: null,
            gtfsId: '1:IDFM:42',
            longName: null,
            mode: 'BUS',
            shortName: '42',
            textColor: null
          }
        },
        stoptimes: [
          {
            departureDelay: 0,
            headsign: 'Downtown',
            realtimeDeparture: 50190,
            realtimeState: 'SCHEDULED',
            scheduledDeparture: 50094,
            serviceDay: 1705046400,
            trip: { route: { shortName: '42' } }
          },
          {
            departureDelay: 0,
            headsign: 'Downtown',
            realtimeDeparture: 50994,
            realtimeState: 'SCHEDULED',
            scheduledDeparture: 50994,
            serviceDay: 1705046400,
            trip: { route: { shortName: '42' } }
          }
        ]
      }
    ],
    ...overrides
  }
}

const defaultComparator = (a, b) =>
  fullTimestamp(a.stoptimes?.[0]) - fullTimestamp(b.stoptimes?.[0])

// Jest maps i18n/*.yml to an empty object, so FormattedMessage would throw on
// missing message ids. Load and flatten the shipped English file instead.
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

function renderStop(stopData) {
  const state = getMockInitialState()
  state.otp.config.homeTimezone = 'America/Los_Angeles'
  const { wrapper } = mockWithProvider(
    Stop,
    {
      fromToSlot: <span />,
      stopData: { ...stopData, nearbyRoutes: stopData.nearbyRoutes }
    },
    state,
    messages
  )
  return wrapper
}

describe('components > viewers > nearby > stop', () => {
  describe('nearbyRoutes filter does not hide departures', () => {
    it('renders departures when stopRoutes is absent (server did not return it)', () => {
      // stopRoutes omitted entirely; nearby-view builds nearbyRoutes = [undefined].
      const stopData = makeStopData({ nearbyRoutes: [undefined] })
      const wrapper = renderStop(stopData)
      expect(wrapper.find('.pattern-row-item').length).toBeGreaterThan(0)
    })

    it('renders departures when nearbyRoutes is an empty list', () => {
      const stopData = makeStopData({ nearbyRoutes: [] })
      const wrapper = renderStop(stopData)
      expect(wrapper.find('.pattern-row-item').length).toBeGreaterThan(0)
    })

    it('filters out patterns whose route is not in nearbyRoutes when it has real ids', () => {
      const stopData = makeStopData({ nearbyRoutes: ['1:IDFM:99'] })
      const wrapper = renderStop(stopData)
      // route 1:IDFM:42 is not in nearbyRoutes -> hidden.
      expect(wrapper.find('.pattern-row-item').length).toBe(0)
    })

    it('keeps patterns whose route is in nearbyRoutes when it has real ids', () => {
      const stopData = makeStopData({ nearbyRoutes: ['1:IDFM:42'] })
      const wrapper = renderStop(stopData)
      expect(wrapper.find('.pattern-row-item').length).toBeGreaterThan(0)
    })
  })

  describe('patternArrayforStops', () => {
    it('deduplicates patterns by headsign + route', () => {
      const stopData = makeStopData()
      const arr = patternArrayforStops(stopData, defaultComparator)
      expect(arr.length).toBe(1)
    })
  })
})
