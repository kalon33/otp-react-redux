import { readFileSync } from 'fs'
import path from 'path'

import { createIntl, IntlProvider } from 'react-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import yaml from 'js-yaml'

import {
  getItineraryDescription,
  ItineraryDescription
} from '../../../lib/components/narrative/default/itinerary-description'

/**
 * Backlog 75.14. A bus leg the GTFS times at 0 seconds (two consecutive stops
 * in the same minute) was never counted as transit by the description, which
 * kept the transit mode only for a leg LONGER than 0 s. The heading came out
 * as the access mode alone, so on the fuzz session's 50 m search (case 26,
 * downtown -> 44.97825,-93.26545, Thu 09:00) the 22 and 48 cards were filed
 * under "WALK" and "BIKE" instead of "Walk + Transit" / "Bike + Transit".
 */

/** Jest maps i18n/*.yml to an empty object; read the shipped English file. */
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
  yaml.load(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)
const intl = createIntl({ locale: 'en-US', messages })

// 2026-10-29 09:00 CDT; legs from OTP n=44 (fuzz/res-44.json.gz).
const T0 = Date.UTC(2026, 9, 29, 14, 0)
const S = 1000
const leg = (
  mode: string,
  startS: number,
  endS: number,
  distance: number,
  routeId?: string
) => ({
  distance,
  duration: endS - startS,
  endTime: T0 + endS * S,
  mode,
  routeId,
  startTime: T0 + startS * S,
  transitLeg: !!routeId
})

// WALK 09:01:25-09:06:00 198 m | BUS/22 09:06:00-09:06:00 127 m | WALK 120 m
const walkBus22 = {
  legs: [
    leg('WALK', 85, 360, 198),
    leg('BUS', 360, 360, 127, '1:22'),
    leg('WALK', 360, 454, 120)
  ]
}
// The same 0 s ride of the 22 with a bike either side (the "BIKE" card).
const bikeBus22 = {
  legs: [
    leg('BICYCLE', 0, 360, 198),
    leg('BUS', 360, 360, 127, '1:22'),
    leg('BICYCLE', 360, 390, 120)
  ]
}
// A 0 s hop before a real Green Line ride: the real ride names the mode.
const hopThenTrain = {
  legs: [
    leg('WALK', 0, 300, 400),
    leg('BUS', 300, 300, 127, '1:22'),
    leg('WALK', 300, 420, 132),
    leg('TRAM', 420, 1500, 9000, '1:902'),
    leg('WALK', 1500, 1600, 100)
  ]
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const describeIt = (itinerary: any, combineTransitModes: boolean) =>
  getItineraryDescription({ combineTransitModes, intl, itinerary })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const render = (itinerary: any) =>
  renderToStaticMarkup(
    <IntlProvider locale="en-US" messages={messages}>
      <ItineraryDescription itinerary={itinerary} />
    </IntlProvider>
  )

describe('backlog 75.14 > a 0-second transit leg is still transit', () => {
  it('heads a walk + 0 s bus card "Walk + Transit", not "Walk"', () => {
    // The production config groups by combined transit modes.
    expect(describeIt(walkBus22, true)).toBe('Walk + Transit')
    expect(describeIt(walkBus22, false)).toBe('Walk + Bus')
  })

  it('heads a bike + 0 s bus card "Bike + Transit", not "Bike"', () => {
    expect(describeIt(bikeBus22, true)).toBe('Bike + Transit')
  })

  it('names the longest transit leg when a 0 s hop comes first', () => {
    expect(describeIt(hopThenTrain, false)).toBe('Walk + Streetcar')
  })

  it('the card description (mini row) agrees with the heading', () => {
    expect(render(walkBus22)).toBe('Walk + Bus')
    expect(render(hopThenTrain)).toBe('Walk + Streetcar')
  })

  it('still reads a street-only itinerary as its access mode', () => {
    expect(describeIt({ legs: [leg('WALK', 0, 303, 219)] }, true)).toBe('Walk')
  })
})
