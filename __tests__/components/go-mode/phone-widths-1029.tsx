import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import yaml from 'js-yaml'
import type { ReactWrapper } from 'enzyme'

import {
  FOLLOW_CLASS_ACTIVE,
  FOLLOW_CLASS_IDLE
} from '../../../lib/components/go-mode/GoModeMap'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import GoModeScreen from '../../../lib/components/go-mode/GoModeScreen'
import TransitProgress from '../../../lib/components/go-mode/TransitProgress'
import WalkingNavigation from '../../../lib/components/go-mode/WalkingNavigation'

// GoModeScreen's children that need a live map, a router or their own store
// slices; this suite is about where the screen PLACES things.
jest.mock('../../../lib/components/go-mode/GoModeMap', () => {
  const actual = jest.requireActual('../../../lib/components/go-mode/GoModeMap')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = jest.requireActual('react')
  return {
    ...actual,
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    default: ({ children }: any) =>
      react.createElement('div', { 'data-testid': 'go-mode-map' }, children)
  }
})
jest.mock('../../../lib/components/mobile/navigation-bar', () => () => null)
jest.mock(
  '../../../lib/components/go-mode/CurrentLegPanel',
  () => () =>
    jest
      .requireActual('react')
      .createElement('div', { 'data-testid': 'current-leg-card' })
)
jest.mock('../../../lib/components/go-mode/TripSheet', () => () => null)
jest.mock('../../../lib/components/go-mode/GoModeStopViewer', () => () => null)
jest.mock('../../../lib/components/go-mode/BoardingPrompt', () => () => null)
jest.mock('../../../lib/components/go-mode/AutoToggle', () => () => null)
jest.mock('../../../lib/components/go-mode/FasterRouteCard', () => () => null)
jest.mock('../../../lib/components/go-mode/AutoSwitchCard', () => () => null)
jest.mock(
  '../../../lib/components/go-mode/use-active-trip-guards',
  () => () => undefined
)

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
const REPO = path.join(__dirname, '..', '..', '..')

/** Every css rule (selector + body) whose selector names one of el's classes. */
function rulesFor(el: Element): string {
  const text = Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent)
    .join('\n')
  const classes = Array.from(el.classList)
  return text
    .split('}')
    .filter((rule) => {
      const selector = rule.split('{')[0] || ''
      return classes.some((c) => selector.includes(`.${c}`))
    })
    .join('}\n')
}

/**
 * Backlog 75.16, from the 2026-10-29 isolated stress-test session (chaos agent
 * C24, C25, C27; perf agent P9's side note). Every case below was measured on
 * otprr main 3a7050816 in headless Chrome with an iPhone user agent at 360,
 * 390 and 430 px, light and dark — the numbers are in each `it`.
 */

const NOW = 1_793_280_000_000

// The C24 trip: bike to I-35W & 46th St Station, then the Orange Line. OTP
// gives the route no short name, so the pill prints the long name.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const orangeLeg: any = {
  from: { name: 'I-35W & 46th St Station', stop: { gtfsId: '1:53542' } },
  headsign: 'ORANGE Downtown Minneapolis',
  mode: 'BUS',
  routeColor: 'F68A1E',
  routeLongName: 'METRO Orange Line',
  routeShortName: null,
  startTime: NOW + 4 * 60000,
  transitLeg: true
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bikeLeg: any = {
  distance: 300,
  duration: 60,
  from: { name: 'Test origin' },
  mode: 'BICYCLE',
  to: { name: 'I-35W & 46th St Station' }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progress = (over: any = {}): any => ({
  currentLegIndex: 0,
  currentLegProgress: 20,
  currentTime: new Date(NOW),
  estimatedArrival: new Date(NOW + 20 * 60000),
  overallProgress: 5,
  plannedDepartureTime: NOW + 4 * 60000,
  status: 'on_track',
  stopsRemaining: 4,
  timeRemaining: 1200,
  ...over
})

let wrappers: ReactWrapper[] = []
afterEach(() => {
  wrappers.forEach((w) => w.unmount())
  wrappers = []
})
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mountIt(Component: any, props: any, state?: any) {
  const mounted = mockWithProvider(Component, props, state, messages)
  wrappers.push(mounted.wrapper)
  return mounted
}

describe('75.16 (e) P9: the card ← says what it does', () => {
  // The card's ← runs GoModeScreen's handleExit: confirm("Are you sure you
  // want to stop tracking this trip?") and endGoMode. A screen-reader rider
  // heard "Back" (common.forms.back) for End trip; the perf harness's
  // `button[aria-label="Back"]` step believed it, too (P9).
  it('the ride card names it End trip, and it still ends the trip', () => {
    // FAILS BEFORE: aria-label "Back".
    const onExit = jest.fn()
    const { wrapper } = mountIt(TransitProgress, {
      leg: orangeLeg,
      onExit,
      progress: progress()
    })
    const button = wrapper.find('button[aria-label="End trip"]').hostNodes()
    expect(button).toHaveLength(1)
    expect(wrapper.find('button[aria-label="Back"]').hostNodes()).toHaveLength(
      0
    )
    button.simulate('click')
    expect(onExit).toHaveBeenCalledTimes(1)
  })

  it('so does the access card (bike to the Orange Line)', () => {
    // FAILS BEFORE: aria-label "Back" (WalkingNavigation.tsx:621).
    const onExit = jest.fn()
    const { wrapper } = mountIt(WalkingNavigation, {
      leg: bikeLeg,
      nextLeg: orangeLeg,
      onExit,
      progress: progress()
    })
    const button = wrapper.find('button[aria-label="End trip"]').hostNodes()
    expect(button).toHaveLength(1)
    button.simulate('click')
    expect(onExit).toHaveBeenCalledTimes(1)
  })
})

describe('75.16 (c) C24: a long route pill no longer starves the headsign', () => {
  // 360 px, light and dark: "ORANGE Downtown Minneapolis" scrollWidth 273 /
  // clientWidth 72 → "ORAN…" beside a "METRO Orange Line" pill that was itself
  // clipped 188/180 by its 60 % cap; 94 px at 390, 134 at 430. jsdom does no
  // layout, so this pins the rules that decide it; the 360/390/430 shots
  // measure it.
  function eyebrowRow() {
    const { wrapper } = mountIt(WalkingNavigation, {
      leg: bikeLeg,
      nextLeg: orangeLeg,
      onExit: () => undefined,
      progress: progress()
    })
    const back = wrapper
      .find('button[aria-label]')
      .hostNodes()
      .first()
      .getDOMNode()
    const row = back.parentElement as HTMLElement
    const [, pill, headsign] = Array.from(row.children)
    return { headsign, pill, row }
  }

  it('renders the pill and the whole headsign in the eyebrow row', () => {
    const { headsign, pill } = eyebrowRow()
    expect(pill.textContent).toBe('METRO Orange Line')
    expect(headsign.textContent).toBe('ORANGE Downtown Minneapolis')
  })

  it('lets the row wrap, so a headsign that does not fit takes its own line', () => {
    // FAILS BEFORE: nowrap row, headsign `flex: 1` (basis 0) — it always
    // stayed beside the pill and took whatever width was left.
    const { headsign, pill, row } = eyebrowRow()
    expect(rulesFor(row)).toMatch(/flex-wrap:\s*wrap/)
    // Only when a pill precedes it: the walk/bike-only eyebrow ("🚲 To …")
    // keeps its one line beside the arrow.
    expect(rulesFor(pill)).toMatch(/\+\s*\.[\w-]+\{[^}]*flex-basis:\s*auto/)
    expect(headsign.tagName).toBe('DIV')
  })

  it('no longer caps the pill at 60 % of the row', () => {
    // FAILS BEFORE: max-width: 60% clipped "METRO Orange Line" 188/180 at 360.
    const { pill } = eyebrowRow()
    expect(rulesFor(pill)).not.toMatch(/max-width:\s*60%/)
    // Its only cap now: the row less the ← target, so it keeps the arrow's
    // line and the headsign is what wraps.
    expect(rulesFor(pill)).toMatch(
      /max-width:\s*calc\(100% - var\(--tn-tap\)\)/
    )
  })
})

describe('75.16 (b) C27: "GPS signal lost" is placed where nothing covers it', () => {
  // 360 and 390 px: the strip rendered AFTER the map, i.e. the last 40 px of
  // the column (y 740 of 780, 804 of 844) — exactly where the absolute
  // "View trip & other ways" tab sits (z-index 1100): elementFromPoint at the
  // strip's centre returned the tab's SPAN at both widths. Placed between the
  // card and the map it is in the column's flow above the map, where none of
  // the bottom overlays (tab, faster-route card, arrival card) reach.
  function screenHtml() {
    const state = getMockInitialState()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const otp = state.otp as any
    otp.goMode = {
      ...(otp.goMode || {}),
      activeItinerary: {
        endTime: NOW + 30 * 60000,
        legs: [
          {
            ...bikeLeg,
            endTime: NOW + 3 * 60000,
            startTime: NOW,
            to: { ...bikeLeg.to, name: 'I-35W & 46th St Station' }
          },
          {
            ...orangeLeg,
            endTime: NOW + 25 * 60000,
            to: { name: 'Downtown Minneapolis' }
          }
        ],
        startTime: NOW
      },
      arrivedAt: null,
      isActive: true,
      progress: progress(),
      tracking: {
        ...(otp.goMode?.tracking || {}),
        // POSITION_UNAVAILABLE, as the outage delivered it (C22).
        error: { code: 2, message: 'Position unavailable' }
      }
    }
    const { wrapper } = mountIt(GoModeScreen, {}, state)
    return wrapper.html()
  }

  it('renders the strip between the card and the map, not under the sheet tab', () => {
    // FAILS BEFORE: the strip came after the map (GoModeScreen.tsx:434-441).
    const html = screenHtml()
    const strip = html.indexOf('GPS signal lost. Trying to reconnect...')
    const card = html.indexOf('data-testid="current-leg-card"')
    const map = html.indexOf('data-testid="go-mode-map"')
    const tab = html.indexOf('View trip &amp; other ways')
    expect(strip).toBeGreaterThan(-1)
    expect(card).toBeGreaterThan(-1)
    expect(map).toBeGreaterThan(-1)
    expect(tab).toBeGreaterThan(-1)
    expect(card).toBeLessThan(strip)
    expect(strip).toBeLessThan(map)
    expect(strip).toBeLessThan(tab)
  })
})

describe('75.16 (d) C25: the two map controls a rider reaches for are 44 px', () => {
  // 29×29 at 360 and 430, light and dark: Go Mode's follow toggle
  // ("Following you") and the planner map's "Find my location". MapLibre
  // sizes `.maplibregl-ctrl-group button` at 29 px; the phone's minimum
  // target is --tn-tap (44 px).
  const base = readFileSync(
    path.join(REPO, 'lib', 'styles', 'base.css'),
    'utf8'
  )

  it('sizes both at --tn-tap on the phone', () => {
    // FAILS BEFORE: no rule; MapLibre's 29 px applied.
    const rule = base.match(
      /html\.tn-mobile \.maplibregl-ctrl-group button\.maplibregl-ctrl-geolocate,\s*html\.tn-mobile \.maplibregl-ctrl-group button\.go-mode-follow-toggle\s*\{([^}]*)\}/
    )
    expect(rule).not.toBeNull()
    expect(rule?.[1]).toMatch(/height:\s*var\(--tn-tap\)/)
    expect(rule?.[1]).toMatch(/width:\s*var\(--tn-tap\)/)
  })

  it('still names the follow toggle by the class the rule selects', () => {
    // The selector is the whole fix; a rename would leave it silently inert.
    expect(FOLLOW_CLASS_IDLE.split(' ')).toContain('go-mode-follow-toggle')
    expect(FOLLOW_CLASS_ACTIVE.split(' ')).toContain('go-mode-follow-toggle')
  })
})
