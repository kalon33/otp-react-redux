import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import { mockWithProvider } from '../../test-utils/mock-data/store'
import SameShapeVariants from '../../../lib/components/narrative/metro/same-shape-variants'

/**
 * Backlog 16.6: the variants behind a result row were reachable only through a
 * 90%-size grey "3 options" link beside "(departs 8:14 AM)", and on 2026-09-15
 * the rider ran three searches and started Go Mode four times in two minutes
 * hunting for a different boarding stop on the same route without finding it.
 * These tests pin the two things that fix: the control is a real, full-width
 * button on the row, and its closed label NAMES the other boarding stop rather
 * than counting it.
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
  yaml.safeLoad(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

// 2026-09-15T15:00:00Z, i.e. 8:00 AM in the suite's fixed TZ (global-setup.js
// pins America/Los_Angeles), so every clock time asserted below is stable.
const BASE = 1_789_484_400_000
const MIN = 60000

type VariantSpec = {
  bikeMeters?: number
  departOffsetMin?: number
  index: number
  stop: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeItinerary = ({
  bikeMeters = 3000,
  departOffsetMin = 0,
  index,
  stop
}: VariantSpec): any => ({
  duration: 2400,
  endTime: BASE + (departOffsetMin + 40) * MIN,
  index,
  legs: [
    {
      distance: bikeMeters,
      from: { lat: 44.94, lon: -93.28, name: 'Home', vertexType: 'NORMAL' },
      mode: 'BICYCLE',
      startTime: BASE + departOffsetMin * MIN,
      to: { lat: 44.95, lon: -93.27, name: stop, vertexType: 'TRANSIT' }
    },
    {
      distance: 9000,
      from: { lat: 44.95, lon: -93.27, name: stop, vertexType: 'TRANSIT' },
      mode: 'BUS',
      route: { id: '1:Orange' },
      routeShortName: 'Orange',
      startTime: BASE + (departOffsetMin + 10) * MIN,
      to: {
        lat: 44.86,
        lon: -93.24,
        name: 'Burnsville',
        vertexType: 'TRANSIT'
      },
      transitLeg: true
    }
  ],
  startTime: BASE + departOffsetMin * MIN
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowOf(specs: VariantSpec[]): any {
  const variants = specs.map(makeItinerary)
  return Object.assign({}, variants[0], { sameShapeVariants: variants })
}

function render(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itinerary: any,
  setActiveItinerary = jest.fn()
) {
  const { wrapper } = mockWithProvider(
    SameShapeVariants,
    { itinerary, setActiveItinerary },
    undefined,
    messages
  )
  return { setActiveItinerary, wrapper }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toggle = (wrapper: any) =>
  wrapper.find('button.same-shape-variants-toggle')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const variantButtons = (wrapper: any) => wrapper.find('button[data-index]')

describe('components > narrative > same shape variants', () => {
  it('renders nothing when the row folded nothing into itself', () => {
    const { wrapper } = render(
      makeItinerary({ index: 0, stop: 'Lake St / Midtown' })
    )
    expect(wrapper.find('.same-shape-variants').length).toBe(0)
    expect(toggle(wrapper).length).toBe(0)
  })

  it('renders nothing when a single itinerary is listed as its own variant', () => {
    const only = makeItinerary({ index: 0, stop: 'Lake St / Midtown' })
    const { wrapper } = render(
      Object.assign({}, only, { sameShapeVariants: [only] })
    )
    expect(toggle(wrapper).length).toBe(0)
  })

  it('offers one full-width control, collapsed, when 2+ itineraries folded in', () => {
    const { wrapper } = render(
      rowOf([
        { index: 0, stop: 'Lake St / Midtown' },
        { departOffsetMin: 12, index: 1, stop: 'Lake St / Midtown' }
      ])
    )
    expect(toggle(wrapper).length).toBe(1)
    expect(toggle(wrapper).prop('aria-expanded')).toBe(false)
    // Folded is still the default: no variant list until it is tapped.
    expect(variantButtons(wrapper).length).toBe(0)
  })

  it('counts the other DEPARTURES on the closed label', () => {
    const { wrapper } = render(
      rowOf([
        { index: 0, stop: 'Lake St / Midtown' },
        { departOffsetMin: 12, index: 1, stop: 'Lake St / Midtown' },
        { departOffsetMin: 27, index: 2, stop: 'Lake St / Midtown' }
      ])
    )
    expect(toggle(wrapper).text()).toContain('2 other times')
  })

  it('NAMES the other boarding stop rather than counting it', () => {
    // The 2026-09-15 ask itself: same route, different place to get on.
    const { wrapper } = render(
      rowOf([
        { index: 0, stop: 'Lake St / Midtown' },
        { departOffsetMin: 12, index: 1, stop: '46th St Station' }
      ])
    )
    const label = toggle(wrapper).text()
    expect(label).toContain('board at 46th St Station')
    expect(label).toContain('1 other time')
  })

  it('names one stop and counts the rest when there are several', () => {
    const { wrapper } = render(
      rowOf([
        { index: 0, stop: 'Lake St / Midtown' },
        { departOffsetMin: 12, index: 1, stop: '46th St Station' },
        { departOffsetMin: 24, index: 2, stop: '38th St Station' }
      ])
    )
    expect(toggle(wrapper).text()).toContain('board at 46th St Station +1 more')
  })

  it('falls back to a plain count when only the closing bike ride differs', () => {
    // Same minute, same boarding stop: there is no axis worth naming, so the
    // control says how many there are rather than inventing a difference.
    const { wrapper } = render(
      rowOf([
        { bikeMeters: 6800, index: 0, stop: 'Lake St / Midtown' },
        { bikeMeters: 2100, index: 1, stop: 'Lake St / Midtown' }
      ])
    )
    const label = toggle(wrapper).text()
    expect(label).toContain('2 options')
    expect(label).not.toContain('other time')
  })

  it('expands and collapses, listing every variant with what differs', () => {
    const { wrapper } = render(
      rowOf([
        { index: 0, stop: 'Lake St / Midtown' },
        {
          bikeMeters: 1200,
          departOffsetMin: 12,
          index: 1,
          stop: '46th St Station'
        }
      ])
    )
    toggle(wrapper).simulate('click')
    wrapper.update()
    expect(toggle(wrapper).prop('aria-expanded')).toBe(true)

    const buttons = variantButtons(wrapper)
    expect(buttons.length).toBe(2)
    // The representative is in the list and marked as the one on screen.
    expect(buttons.at(0).prop('className')).toBe('active')
    const second = buttons.at(1).text()
    expect(second).toContain('Board at 46th St Station')
    // Departure and arrival, plus the biking distance that is the whole point
    // of keeping a same-minute variant around.
    expect(second).toContain('8:12 AM')
    expect(second).toContain('8:52 AM')
    expect(second).toMatch(/biking/)

    toggle(wrapper).simulate('click')
    wrapper.update()
    expect(toggle(wrapper).prop('aria-expanded')).toBe(false)
    expect(variantButtons(wrapper).length).toBe(0)
  })

  it('selects the tapped variant, by its own itinerary index', () => {
    const setActiveItinerary = jest.fn()
    const { wrapper } = render(
      rowOf([
        { index: 4, stop: 'Lake St / Midtown' },
        { departOffsetMin: 12, index: 7, stop: '46th St Station' }
      ]),
      setActiveItinerary
    )
    toggle(wrapper).simulate('click')
    wrapper.update()
    variantButtons(wrapper).at(1).simulate('click')
    expect(setActiveItinerary).toHaveBeenCalledTimes(1)
    expect(setActiveItinerary.mock.calls[0][0].index).toBe(7)
  })

  it('does not let a tap on the control fall through to the row', () => {
    // The whole card is clickable (MetroItinerary.handleClick); without
    // stopPropagation, opening the list would also activate the row.
    const rowClick = jest.fn()
    const { wrapper } = render(
      rowOf([
        { index: 0, stop: 'Lake St / Midtown' },
        { departOffsetMin: 12, index: 1, stop: '46th St Station' }
      ])
    )
    const event = { stopPropagation: rowClick }
    toggle(wrapper).simulate('click', event)
    expect(rowClick).toHaveBeenCalled()
  })
})
