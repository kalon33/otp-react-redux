import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import AlightRecommendation from '../../../lib/components/go-mode/AlightRecommendation'

/**
 * The options list is OnboardItineraryList's business (and has its own suite);
 * mounting the real one here would drag in ComponentContext's ItineraryBody.
 * The stub exposes one button per option that calls the row/variant callbacks,
 * which is the only part of it this suite is about.
 */
jest.mock('../../../lib/components/go-mode/OnboardItineraryList', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const StubList = ({ onPreview, onPreviewVariant, options }: any) => (
    <div className="stub-options">
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {options.map((option: any, i: number) => (
        <div key={i}>
          <button
            className={`row-${i}`}
            onClick={() => onPreview(option)}
            type="button"
          >
            row
          </button>
          <button
            className={`variant-${i}`}
            onClick={() => onPreviewVariant(option)}
            type="button"
          >
            variant
          </button>
        </div>
      ))}
    </div>
  )
  return { __esModule: true, default: StubList }
})

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

const T = 1789505000000
const MIN = 60000

/** An alight option whose displayed trip is bus → (wait) → bike. */
const option = (
  stopName: string,
  {
    arriveMs = T + 30 * MIN,
    waitMs = 0
  }: { arriveMs?: number; waitMs?: number }
) => ({
  busArrivalEpoch: T + 10 * MIN,
  displayItinerary: {
    endTime: arriveMs,
    legs: [
      {
        endTime: T + 10 * MIN,
        intermediateStops: [{ name: 'a' }, { name: 'b' }],
        mode: 'BUS',
        routeShortName: 'Orange',
        startTime: T,
        to: { name: stopName },
        transitLeg: true
      },
      {
        endTime: arriveMs,
        mode: 'BICYCLE',
        startTime: T + 10 * MIN + waitMs,
        to: { name: 'Safelite AutoGlass' },
        transitLeg: false
      }
    ],
    startTime: T
  },
  itinerary: { legs: [] },
  realtime: true,
  stopId: `1:${stopName}`,
  stopName
})

const OPTIONS = [
  option('I-35W & 46th St Station', { arriveMs: T + 30 * MIN }),
  option('2nd Ave S & Washington Ave S', {
    arriveMs: T + 52 * MIN,
    waitMs: 17 * MIN
  })
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(previewIndex: number | null = null) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.config = { ...(otp.config || {}), homeTimezone: 'America/Chicago' }
  otp.goMode = {
    ...(otp.goMode || {}),
    isActive: true,
    onboard: {
      alightOptions: OPTIONS,
      answeredCandidates: 2,
      bestAlightStop: OPTIONS[0],
      candidates: [],
      keepRouteId: null,
      pendingCandidates: 0,
      preview:
        previewIndex == null
          ? null
          : {
              control: 'row' as const,
              openedAtMs: T,
              option: OPTIONS[previewIndex]
            },
      status: 'ready',
      trip: { id: '1:1346665' },
      vehicle: { vehicleId: '1:8141' }
    },
    tracking: { ...(otp.goMode?.tracking || {}), lastPosition: null }
  }
  return mockWithProvider(AlightRecommendation, {}, state, messages)
}

/**
 * Backlog 17.1, the rider's SECOND ask — 2026-09-15 15:57:02:
 *
 * > Again: I just want to view alternatives for searches on "already on bus".
 * > But just viewing switched and then other options are gone
 *
 * Telemetry: `SET_ONBOARD_RESULT` at 15:54:19 (5 options, pendingCandidates 0),
 * 1m54s of the rider reading the list, then `CLEAR_ONBOARD` + `START_GO_MODE`
 * in ONE tick at 15:56:13 — the tap that meant "show me this one" was the
 * commit, and `clearOnboard()` dropped `onboard.alightOptions`, the only copy.
 * Recovering the list cost five fresh OTP plan requests (15:57:15–15:57:19).
 *
 * The shape the rider approved: a tap opens a preview screen for that option
 * with `Confirm this stop` / `Back to options`, the list stays alive
 * underneath, and the commit happens only from Confirm.
 */
describe('components > go-mode > onboard alight preview (17.1)', () => {
  describe('a tap on a row previews and commits nothing', () => {
    it('dispatches OPEN_ONBOARD_PREVIEW, never CLEAR_ONBOARD/START_GO_MODE', () => {
      const { store, wrapper } = render()
      wrapper.find('button.row-1').simulate('click')
      const types = store.getActions().map((a: { type: string }) => a.type)
      expect(types).toContain('OPEN_ONBOARD_PREVIEW')
      // The whole point: 15:56:13's pair must not be in here.
      expect(types).not.toContain('CLEAR_ONBOARD')
      expect(types).not.toContain('START_GO_MODE')
    })

    it('names the tapped option in the OPEN payload, not the ranked best', () => {
      const { store, wrapper } = render()
      wrapper.find('button.row-1').simulate('click')
      const open = store
        .getActions()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((a: any) => a.type === 'OPEN_ONBOARD_PREVIEW')
      expect(open.payload).toEqual(
        expect.objectContaining({
          control: 'row',
          index: 1,
          stopId: '1:2nd Ave S & Washington Ave S'
        })
      )
    })

    /**
     * 17.11: nothing in the stream recorded that a tap had happened, so the
     * rider's 15:53:50 "clicking does nothing" could be neither confirmed nor
     * contradicted. One entry per tap, naming the control.
     */
    it('records the tap as a Go Mode control tap (17.11)', () => {
      const { store, wrapper } = render()
      wrapper.find('button.row-1').simulate('click')
      const tap = store
        .getActions()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((a: any) => a.type === 'GO_MODE_CONTROL_TAP')
      expect(tap.payload).toEqual(
        expect.objectContaining({
          control: 'onboard-option-row',
          index: 1,
          optionCount: 2,
          stopId: '1:2nd Ave S & Washington Ave S'
        })
      )
      expect(typeof tap.payload.tMs).toBe('number')
    })
  })

  describe('the same-shape drill-down opens the preview too', () => {
    /**
     * `SameShapeVariants`' `setActiveItinerary` means "show me this variant
     * instead" everywhere else in the app; in the onboard list it started the
     * trip, so the one control built for VIEWING alternatives committed
     * hardest.
     */
    it('previews the chosen variant and commits nothing', () => {
      const { store, wrapper } = render()
      wrapper.find('button.variant-1').simulate('click')
      const types = store.getActions().map((a: { type: string }) => a.type)
      expect(types).toContain('OPEN_ONBOARD_PREVIEW')
      expect(types).not.toContain('CLEAR_ONBOARD')
      expect(types).not.toContain('START_GO_MODE')
      const tap = store
        .getActions()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((a: any) => a.type === 'GO_MODE_CONTROL_TAP')
      expect(tap.payload.control).toBe('onboard-variant-open')
    })
  })

  describe('the preview screen', () => {
    it('replaces the options list with the option, arrival and its wait', () => {
      const { wrapper } = render(1)
      expect(
        wrapper.find('[data-testid="onboard-preview"]').length
      ).toBeGreaterThan(0)
      expect(wrapper.find('div.stub-options')).toHaveLength(0)
      const text = wrapper.text()
      expect(text).toContain('Off at 2nd Ave S & Washington Ave S')
      // 17 minutes of it, which is exactly what the ranker scores as free
      // (backlog 15.9) and what the row cannot show.
      expect(text).toContain('17 min wait')
      expect(text).toContain('Arrive')
      expect(text).toContain('Confirm this stop')
      expect(text).toContain('Back to options')
    })

    it('says nothing about waiting when the option implies none', () => {
      const { wrapper } = render(0)
      expect(wrapper.text()).not.toContain('min wait')
    })

    it('Back restores the same options with no re-plan and no refetch', () => {
      const { store, wrapper } = render(1)
      wrapper
        .find('button[data-testid="onboard-preview-back"]')
        .simulate('click')
      const types = store.getActions().map((a: { type: string }) => a.type)
      expect(types).toContain('CLOSE_ONBOARD_PREVIEW')
      // Nothing that re-plans, re-optimizes or leaves the flow: the list is
      // still in state, which is what makes Back free. The five OTP requests
      // of 15:57:15–19 are what this is here to prevent.
      expect(types).not.toContain('START_ONBOARD_OPTIMIZE')
      expect(types).not.toContain('SET_ONBOARD_STATUS')
      expect(types).not.toContain('BEGIN_ONBOARD_FLOW')
      expect(types).not.toContain('CLEAR_ONBOARD')
      expect(types).not.toContain('START_GO_MODE')
      const tap = store
        .getActions()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .find((a: any) => a.type === 'GO_MODE_CONTROL_TAP')
      expect(tap.payload.control).toBe('onboard-preview-back')
    })
  })
})
