import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import { collectItinerariesWithoutDuplicates } from '../../../lib/util/itinerary'
import { doMergeItineraries } from '../../../lib/components/narrative/narrative-itineraries'
import { mockWithProvider } from '../../test-utils/mock-data/store'
import lakeStRide from '../../../lib/util/go-mode/replay/fixtures/0921-0902-orange-lake-st.json'
import SameShapeVariants, {
  stopPairOf,
  stopPairs
} from '../../../lib/components/narrative/metro/same-shape-variants'

/**
 * Backlog 21.5 (2026-09-23). The row's drill-down is "Other stops": one entry
 * per distinct get-on / get-off pair among the runs folded into the row, the
 * row's own pair first, and no button at all when every run gets on and off
 * where the row already does. The rider: "it should be other boarding and
 * egress stops, just like you can choose other egress stops in the 'already
 * on the bus' flow", "description on button is just other stops", "you dont
 * need to clarify if there are no options". Other departures from the same
 * stops are the "You leave ..." sentence's job, not this control's.
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
  alight?: string
  bikeMeters?: number
  departOffsetMin?: number
  index: number
  stop: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeItinerary = ({
  alight = 'I-35W & 98th St Station',
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
      to: { lat: 44.86, lon: -93.24, name: alight, vertexType: 'TRANSIT' },
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
const pairButtons = (wrapper: any) => wrapper.find('button[data-pair]')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function open(wrapper: any) {
  toggle(wrapper).simulate('click')
  wrapper.update()
}

/** Five departures, three pairs: the shape of an Orange Line row. */
const FIVE_RUNS_THREE_PAIRS: VariantSpec[] = [
  { bikeMeters: 1500, index: 0, stop: 'Lake St / Midtown' },
  {
    bikeMeters: 1500,
    departOffsetMin: 15,
    index: 1,
    stop: 'Lake St / Midtown'
  },
  {
    alight: 'I-35W & 66th St Station',
    bikeMeters: 4200,
    departOffsetMin: 21,
    index: 2,
    stop: 'Lake St / Midtown'
  },
  { bikeMeters: 2600, departOffsetMin: 27, index: 3, stop: '46th St Station' },
  { bikeMeters: 2600, departOffsetMin: 9, index: 4, stop: '46th St Station' }
]

describe('components > narrative > same shape variants (21.5: other stops)', () => {
  it('renders nothing when the row folded nothing into itself', () => {
    const { wrapper } = render(
      makeItinerary({ index: 0, stop: 'Lake St / Midtown' })
    )
    expect(wrapper.find('.same-shape-variants').length).toBe(0)
    expect(toggle(wrapper).length).toBe(0)
  })

  it('renders nothing when every run gets on and off where the row does', () => {
    // Four departures, one pair: other TIMES are the sentence's job, and
    // "you dont need to clarify if there are no options".
    const { wrapper } = render(
      rowOf([
        { index: 0, stop: 'Lake St / Midtown' },
        { departOffsetMin: 12, index: 1, stop: 'Lake St / Midtown' },
        { departOffsetMin: 27, index: 2, stop: 'Lake St / Midtown' },
        { bikeMeters: 900, index: 3, stop: 'Lake St / Midtown' }
      ])
    )
    expect(wrapper.find('.same-shape-variants').length).toBe(0)
    expect(toggle(wrapper).length).toBe(0)
  })

  it('says "Other stops" on the button and nothing else', () => {
    const { wrapper } = render(rowOf(FIVE_RUNS_THREE_PAIRS))
    expect(toggle(wrapper).length).toBe(1)
    expect(toggle(wrapper).text()).toBe('Other stops▶')
    expect(toggle(wrapper).prop('aria-expanded')).toBe(false)
    expect(pairButtons(wrapper).length).toBe(0)
  })

  it('offers the button for another get-off stop alone, too', () => {
    const { wrapper } = render(
      rowOf([
        { index: 0, stop: 'Lake St / Midtown' },
        {
          alight: 'I-35W & 66th St Station',
          index: 1,
          stop: 'Lake St / Midtown'
        }
      ])
    )
    expect(toggle(wrapper).text()).toBe('Other stops▶')
  })

  it("lists one entry per distinct pair, the row's own first and marked", () => {
    const { wrapper } = render(rowOf(FIVE_RUNS_THREE_PAIRS))
    open(wrapper)
    const buttons = pairButtons(wrapper)
    expect(buttons.length).toBe(3)
    const texts = buttons.map((b: any) => b.find('span').first().text())
    // Own pair, then the others by their next departure (46th St at 8:09
    // before the 66th St alight at 8:21).
    expect(texts[0]).toBe('OnLake St / MidtownOffI-35W & 98th St Station')
    expect(texts[1]).toBe('On46th St StationOffI-35W & 98th St Station')
    expect(texts[2]).toBe('OnLake St / MidtownOffI-35W & 66th St Station')
    expect(buttons.at(0).prop('className')).toBe('active')
    expect(buttons.at(0).text()).toContain('currently shown')
    expect(buttons.at(1).prop('className')).toBeUndefined()
  })

  it('details each entry as distance and when it arrives (and leaves, when that differs)', () => {
    const { wrapper } = render(rowOf(FIVE_RUNS_THREE_PAIRS))
    open(wrapper)
    const details = pairButtons(wrapper).map((b: any) =>
      b.find('.variant-detail').text()
    )
    expect(details[0]).toMatch(
      /^0\.9 miles? biking · arrives 8:40 AM currently shown$/
    )
    // 46th St runs leave at 8:27 and 8:09: the earlier, 8:09, is named
    // because it differs from the row's 8:00; each arrives 40 min later.
    expect(details[1]).toMatch(
      /^1\.6 miles? biking · leaves 8:09 AM · arrives 8:49 AM$/
    )
    expect(details[2]).toMatch(
      /^2\.6 miles? biking · leaves 8:21 AM · arrives 9:01 AM$/
    )
  })

  it('says walking when the pair has no biking', () => {
    const walkRow = rowOf([
      { index: 0, stop: 'Lake St / Midtown' },
      { index: 1, stop: '46th St Station' }
    ])
    walkRow.sameShapeVariants.forEach((v: any) => {
      v.legs[0].mode = 'WALK'
      v.legs[0].distance = 400
    })
    const { wrapper } = render(walkRow)
    open(wrapper)
    expect(pairButtons(wrapper).at(1).find('.variant-detail').text()).toMatch(
      /walking · arrives 8:40 AM$/
    )
  })

  it("selects the pair's EARLIEST run when tapped", () => {
    const { setActiveItinerary, wrapper } = render(rowOf(FIVE_RUNS_THREE_PAIRS))
    open(wrapper)
    pairButtons(wrapper).at(1).simulate('click')
    expect(setActiveItinerary).toHaveBeenCalledTimes(1)
    // index 4 (8:09), not index 3 (8:27).
    expect(setActiveItinerary.mock.calls[0][0].index).toBe(4)
  })

  it('collapses again', () => {
    const { wrapper } = render(rowOf(FIVE_RUNS_THREE_PAIRS))
    open(wrapper)
    expect(toggle(wrapper).prop('aria-expanded')).toBe(true)
    open(wrapper)
    expect(toggle(wrapper).prop('aria-expanded')).toBe(false)
    expect(pairButtons(wrapper).length).toBe(0)
  })

  it('does not let a tap on the control fall through to the row', () => {
    // The whole card is clickable (MetroItinerary.handleClick); without
    // stopPropagation, opening the list would also activate the row.
    const rowClick = jest.fn()
    const { wrapper } = render(rowOf(FIVE_RUNS_THREE_PAIRS))
    toggle(wrapper).simulate('click', { stopPropagation: rowClick })
    expect(rowClick).toHaveBeenCalled()
  })
})

describe('21.5 > how a pair is identified', () => {
  const withIds = (spec: VariantSpec, on: string, off: string): any => {
    const itin = makeItinerary(spec)
    itin.legs[1].from.stop = { gtfsId: on }
    itin.legs[1].to.stop = { gtfsId: off }
    return itin
  }

  it('compares stops by GTFS id before names', () => {
    const a = withIds({ index: 0, stop: 'Lake St' }, '1:17781', '1:56833')
    const b = withIds(
      { index: 1, stop: 'Lake St Station' },
      '1:17781',
      '1:56833'
    )
    const c = withIds({ index: 2, stop: 'Lake St' }, '2:17781', '1:56833')
    expect(stopPairOf(a).key).toBe(stopPairOf(b).key)
    expect(stopPairOf(a).key).not.toBe(stopPairOf(c).key)
  })

  it('names a transfer chain by its first boarding and last alight', () => {
    const chain = makeItinerary({ index: 0, stop: 'Lake St / Midtown' })
    chain.legs.push({
      from: { name: 'Transfer Pt' },
      mode: 'BUS',
      to: { name: 'Mall of America' },
      transitLeg: true
    })
    expect(stopPairOf(chain)).toMatchObject({
      offName: 'Mall of America',
      onName: 'Lake St / Midtown'
    })
  })

  it('lets the onboard list name the get-off stop it is choosing', () => {
    const variant = {
      ...makeItinerary({ index: 0, stop: 'Lake St / Midtown' }),
      offStopName: '46th St Station'
    }
    expect(stopPairOf(variant).offName).toBe('46th St Station')
  })

  it('keeps every run and the row itself in the merged sameShapeVariants', () => {
    // A real answer: the 2026-09-21 Orange Line search (replay fixture
    // 0921-0902-orange-lake-st, routingResponses[8], 18 itineraries). The
    // Orange row's earliest run boards at 46th St (9:06 AM Minneapolis); six
    // later runs board at Lake St. After 28.4 allStartTimes holds same-stop
    // runs only, so "You leave" names the 46th St run alone and the six Lake
    // St runs are reachable only through sameShapeVariants -> Other stops.
    const list = collectItinerariesWithoutDuplicates([
      (lakeStRide as any).routingResponses[8].payload.response
    ] as any).map((itin: any, index: number) => ({ ...itin, index }))
    const { mergedItineraries } = doMergeItineraries(
      list,
      { mediumId: null, riderCategoryId: null },
      true
    )
    let folded = 0
    mergedItineraries.forEach((row: any) => {
      const variants = row.sameShapeVariants
      if (!variants) {
        folded += 1
        return
      }
      folded += variants.length
      expect(variants.some((v: any) => v.index === row.index)).toBe(true)
    })
    // Every itinerary lands in exactly one row ...
    expect(folded).toBe(list.length)
    // ... and the Orange row offers both boarding stops.
    const orange = mergedItineraries.find(
      (row: any) => row.sameShapeVariants?.length === 7
    )
    expect(orange).toBeDefined()
    expect(orange.allStartTimes).toHaveLength(1)
    const pairs = stopPairs(orange)
    expect(
      pairs.map((pair) => [pair.onName, pair.offName, pair.variants.length])
    ).toEqual([
      ['I-35W & 46th St Station', 'I-35W & 98th St Station', 1],
      ['I-35W & Lake St Station', 'I-35W & 98th St Station', 6]
    ])
    // "next" for Lake St is the earliest of its six runs.
    expect(pairs[1].next.startTime).toBe(
      Math.min(...pairs[1].variants.map((v) => v.startTime))
    )
  })
})

/**
 * 21.5, third sighting (2026-09-23 15:37): "Why am I not getting an option to
 * get off at 46th st station???" Every one of the Orange Line row's 13 runs
 * got on and off at the same pair, so the control above was not there. In the
 * planner's list (`onLookup` given) a transit row always has the button, and
 * the first tap looks the other stops up.
 */
describe('21.5 > "Other stops" looks the other stops up', () => {
  const ONE_PAIR: VariantSpec[] = [
    { index: 0, stop: 'I-35W & 98th St Station' },
    { departOffsetMin: 15, index: 1, stop: 'I-35W & 98th St Station' }
  ]

  function renderLookup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    itinerary: any,
    lookupStatus?: 'pending' | 'done' | 'failed'
  ) {
    const onLookup = jest.fn()
    const { wrapper } = mockWithProvider(
      SameShapeVariants,
      { itinerary, lookupStatus, onLookup, setActiveItinerary: jest.fn() },
      undefined,
      messages
    )
    return { onLookup, wrapper }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const looking = (wrapper: any) => wrapper.find('p.other-stops-looking')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const none = (wrapper: any) => wrapper.find('p.other-stops-none')

  it('shows the button on a one-pair transit row, and asks on the first tap only', () => {
    const { onLookup, wrapper } = renderLookup(rowOf(ONE_PAIR))
    expect(toggle(wrapper).text()).toBe('Other stops▶')
    open(wrapper)
    expect(onLookup).toHaveBeenCalledTimes(1)
    // Closing does not ask; nothing is listed for a single pair.
    open(wrapper)
    expect(onLookup).toHaveBeenCalledTimes(1)
    expect(pairButtons(wrapper).length).toBe(0)
  })

  it('does not ask again once the row has a lookup status', () => {
    const { onLookup, wrapper } = renderLookup(rowOf(ONE_PAIR), 'done')
    open(wrapper)
    expect(onLookup).not.toHaveBeenCalled()
  })

  it('has no button on a row with no transit leg', () => {
    const bikeOnly = makeItinerary({ index: 0, stop: 'Home' })
    bikeOnly.legs = [bikeOnly.legs[0]]
    const { wrapper } = renderLookup(bikeOnly)
    expect(toggle(wrapper).length).toBe(0)
  })

  it('says "Looking…" while the lookup is out, and nothing else', () => {
    const { wrapper } = renderLookup(rowOf(ONE_PAIR), 'pending')
    open(wrapper)
    expect(looking(wrapper).text()).toBe('Looking…')
    expect(none(wrapper).length).toBe(0)
    expect(pairButtons(wrapper).length).toBe(0)
  })

  it('keeps listing what is already there while looking', () => {
    const { wrapper } = renderLookup(rowOf(FIVE_RUNS_THREE_PAIRS), 'pending')
    open(wrapper)
    expect(pairButtons(wrapper).length).toBe(3)
    expect(looking(wrapper).length).toBe(1)
  })

  it('says "No other stops" once when the lookup found nothing', () => {
    const { wrapper } = renderLookup(rowOf(ONE_PAIR), 'done')
    // Not before the rider opens it.
    expect(none(wrapper).length).toBe(0)
    open(wrapper)
    expect(none(wrapper).length).toBe(1)
    expect(none(wrapper).text()).toBe('No other stops')
    expect(looking(wrapper).length).toBe(0)
  })

  it('says the same when the lookup failed', () => {
    const { wrapper } = renderLookup(rowOf(ONE_PAIR), 'failed')
    open(wrapper)
    expect(none(wrapper).text()).toBe('No other stops')
  })

  it('lists the found pairs and says nothing more once they are in', () => {
    const { wrapper } = renderLookup(rowOf(FIVE_RUNS_THREE_PAIRS), 'done')
    open(wrapper)
    expect(pairButtons(wrapper).length).toBe(3)
    expect(none(wrapper).length).toBe(0)
    expect(looking(wrapper).length).toBe(0)
  })
})
