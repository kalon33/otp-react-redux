import '../../test-utils/mock-window-matchMedia'
import { GeolocateControl } from 'react-map-gl/maplibre'
import { IntlProvider } from 'react-intl'
import { readFileSync } from 'fs'
import Enzyme, { mount, shallow } from 'enzyme'
import EnzymeReactAdapter from 'enzyme-adapter-react-16'

import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import {
  DefaultMap,
  hidePlannerGeolocateControl,
  mapStateToProps
} from '../../../lib/components/map/default-map'
import {
  FOLLOW_ACTIVE_BG,
  FOLLOW_CLASS_ACTIVE,
  FOLLOW_CLASS_IDLE,
  FollowButtonControl,
  FollowToggleControl
} from '../../../lib/components/go-mode/GoModeMap'
import { getMockInitialState } from '../../test-utils/mock-data/store'

// The follow toggle is a native MapLibre IControl, so the only way to see the
// label a rider actually gets is to let the real component build it. Stand in
// for react-map-gl's useControl (which needs a live map) and keep the control
// the component made.
const mockControls: FollowButtonControl[] = []
jest.mock('react-map-gl/maplibre', () => {
  const actual = jest.requireActual('react-map-gl/maplibre')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const react = jest.requireActual('react')
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useControl: (onCreate: (ctx: any) => any) => {
      const ref = react.useRef(null)
      if (!ref.current) {
        ref.current = onCreate({})
        ref.current.onAdd()
        mockControls.push(ref.current)
      }
      return ref.current
    }
  }
})

Enzyme.configure({ adapter: new EnzymeReactAdapter() })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const loadMessages = (file: string) =>
  flatten(
    yaml.safeLoad(
      readFileSync(path.join(__dirname, '../../../i18n/', file), 'utf8')
    )
  )

/**
 * Backlog 21.4. Ride mua45zwn-ik29ib, 2026-09-20 12:58:28: "What is the
 * intended purpose of the 2 gps buttons on the top left. I don't understand
 * how they are separate."
 *
 * Two unrelated controls were stacked at the top-left of the Go Mode map.
 * The upper one is MapLibre's GeolocateControl, rendered by the planner map
 * that GoModeMap wraps — one-shot, it writes the PLANNER's "my location" and
 * touches no Go Mode state. The lower one is Go Mode's follow toggle, and its
 * engaged colour was MapLibre's own active blue #33b5e5, so engaged read as a
 * second native control rather than as a toggle. The rider alternated between
 * the two four times in six seconds (12:57:21-27).
 *
 * Rider's decision, 2026-09-21: hide the crosshair while Go Mode is up.
 */

// The one state the gate reads, on top of a real initial store so the rest of
// mapStateToProps runs the way it does in the app.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stateWith = (goMode: any): any => {
  const state = getMockInitialState()
  state.otp.goMode = goMode
  return state
}

// Enough props for one render() pass; no live MapLibre instance and no store.
const mapProps = (overrides = {}) => ({
  bikeRentalQuery: jest.fn(),
  bikeRentalStations: [],
  carRentalQuery: jest.fn(),
  carRentalStations: [],
  config: { api: {}, map: {} },
  feeds: [],
  findFeeds: jest.fn(),
  findStopTimesForStop: jest.fn(),
  getCurrentPosition: jest.fn(),
  intl: {
    formatList: (items: string[]) => items.join(', '),
    formatMessage: ({ id }: { id: string }) => id
  },
  mapConfig: { overlays: [] },
  query: {},
  rentalVehicleQuery: jest.fn(),
  rentalVehicles: [],
  setLocation: jest.fn(),
  setMapPopupLocationAndGeocode: jest.fn(),
  setViewedStop: jest.fn(),
  updateOverlayVisibility: jest.fn(),
  viewedRouteStops: null,
  ...overrides
})

const countCrosshairs = (props: Record<string, unknown>) =>
  shallow(<DefaultMap {...props} />).find(GeolocateControl).length

describe('components > map > the two GPS buttons (backlog 21.4)', () => {
  describe("the planner's locate crosshair", () => {
    it('is not rendered at all while a live trip is on screen', () => {
      // FAILS BEFORE: the crosshair rendered on every Go Mode map.
      expect(countCrosshairs(mapProps({ hideGeolocateControl: true }))).toBe(0)
    })

    it('is rendered on the planner map', () => {
      expect(countCrosshairs(mapProps({ hideGeolocateControl: false }))).toBe(1)
    })

    it('is rendered when the prop is absent (planner default)', () => {
      expect(countCrosshairs(mapProps())).toBe(1)
    })

    it('comes back the moment the trip ends', () => {
      const wrapper = shallow(
        <DefaultMap {...mapProps({ hideGeolocateControl: true })} />
      )
      expect(wrapper.find(GeolocateControl).length).toBe(0)
      wrapper.setProps({ hideGeolocateControl: false })
      expect(wrapper.find(GeolocateControl).length).toBe(1)
    })
  })

  describe('hidePlannerGeolocateControl', () => {
    it('is true only for a foregrounded live trip', () => {
      expect(
        hidePlannerGeolocateControl({
          isActive: true,
          ui: { backgrounded: false }
        })
      ).toBe(true)
      expect(
        hidePlannerGeolocateControl({
          isActive: true,
          ui: { backgrounded: true }
        })
      ).toBe(false)
      expect(hidePlannerGeolocateControl({ isActive: false, ui: {} })).toBe(
        false
      )
      expect(hidePlannerGeolocateControl(undefined)).toBe(false)
    })

    it('reaches the map through mapStateToProps', () => {
      expect(
        mapStateToProps(
          stateWith({ isActive: true, ui: { backgrounded: false } })
        ).hideGeolocateControl
      ).toBe(true)
      // Stepping out to the planner mid-trip puts the planner's map on screen,
      // and its crosshair is wanted there.
      expect(
        mapStateToProps(
          stateWith({ isActive: true, ui: { backgrounded: true } })
        ).hideGeolocateControl
      ).toBe(false)
      expect(mapStateToProps(stateWith(undefined)).hideGeolocateControl).toBe(
        false
      )
    })
  })

  describe("Go Mode's follow toggle reads as a toggle", () => {
    const build = () => {
      const control = new FollowButtonControl(jest.fn())
      const container = control.onAdd() as HTMLElement
      const button = container.querySelector('button') as HTMLButtonElement
      return { button, control }
    }

    it('starts disengaged', () => {
      const { button } = build()
      expect(button.className).toBe(FOLLOW_CLASS_IDLE)
      expect(button.getAttribute('aria-pressed')).toBe('false')
    })

    it('carries a distinct class and aria-pressed per state', () => {
      const { button, control } = build()
      control.setActive(true)
      expect(button.className).toBe(FOLLOW_CLASS_ACTIVE)
      expect(button.getAttribute('aria-pressed')).toBe('true')
      control.setActive(false)
      expect(button.className).toBe(FOLLOW_CLASS_IDLE)
      expect(button.getAttribute('aria-pressed')).toBe('false')
      expect(FOLLOW_CLASS_ACTIVE).not.toBe(FOLLOW_CLASS_IDLE)
    })

    it('fills the whole button when engaged rather than tinting the glyph', () => {
      const { button, control } = build()
      control.setActive(true)
      expect(button.style.backgroundColor).not.toBe('')
      const active = button.querySelector('svg')?.getAttribute('fill')
      control.setActive(false)
      expect(button.style.backgroundColor).toBe('')
      const idle = button.querySelector('svg')?.getAttribute('fill')
      expect(active).not.toBe(idle)
    })

    it("never wears MapLibre's own active blue", () => {
      // The whole confusion: engaged looked exactly like the native control's
      // active state, one button above it.
      const { button, control } = build()
      control.setActive(true)
      expect(button.querySelector('svg')?.getAttribute('fill')).not.toBe(
        '#33b5e5'
      )
      expect(FOLLOW_ACTIVE_BG).not.toBe('#33b5e5')
      expect(button.outerHTML).not.toContain('#33b5e5')
    })

    it('says which state it is in, in the label and the tooltip', () => {
      const { button, control } = build()
      control.setLabel('Following you')
      expect(button.getAttribute('aria-label')).toBe('Following you')
      expect(button.title).toBe('Following you')
      control.setLabel('Follow me')
      expect(button.getAttribute('aria-label')).toBe('Follow me')
      expect(button.title).toBe('Follow me')
    })
  })

  describe('the label the rider actually gets', () => {
    const messages = loadMessages('en-US.yml')

    const labelFor = (active: boolean) => {
      mockControls.length = 0
      mount(
        <IntlProvider defaultLocale="en-US" locale="en-US" messages={messages}>
          <FollowToggleControl active={active} onToggle={jest.fn()} />
        </IntlProvider>
      )
      return mockControls[0].button?.getAttribute('aria-label')
    }

    it('names the state, not the action, when engaged', () => {
      // FAILS BEFORE: one label, "Follow my location", in both states.
      expect(labelFor(true)).toBe('Following you')
    })

    it('names the action when disengaged', () => {
      expect(labelFor(false)).toBe('Follow me')
    })

    it('has both strings in en-US and fr, so check:i18n stays green', () => {
      const fr = loadMessages('fr.yml')
      ;['followToggleOn', 'followToggleOff'].forEach((key) => {
        expect(messages[`components.GoMode.${key}`]).toBeTruthy()
        expect(fr[`components.GoMode.${key}`]).toBeTruthy()
      })
      expect(messages['components.GoMode.followToggleOn']).not.toBe(
        messages['components.GoMode.followToggleOff']
      )
    })
  })
})
