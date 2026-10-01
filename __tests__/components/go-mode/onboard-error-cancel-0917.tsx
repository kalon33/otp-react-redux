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

const T = 1789505835000

/**
 * The error card, with or without a live trip underneath it. `activeItinerary`
 * is the whole difference: `BEGIN_ONBOARD_FLOW` nulls it on the pre-trip path
 * ("I'm already on the bus" from the search form) and `replanFromAboard`
 * leaves it standing on the mid-ride path, which is also the only path on
 * which the onboard panel renders OVER a running trip.
 */
function render({ midRide }: { midRide: boolean }) {
  const state = getMockInitialState()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otp = state.otp as any
  otp.config = { ...(otp.config || {}), homeTimezone: 'America/Chicago' }
  otp.goMode = {
    ...(otp.goMode || {}),
    activeItinerary: midRide
      ? {
          endTime: T + 30 * 60000,
          legs: [
            {
              mode: 'BUS',
              routeShortName: 'Orange',
              transitLeg: true
            }
          ],
          startTime: T
        }
      : null,
    isActive: midRide,
    onboard: {
      ...(otp.goMode?.onboard || {}),
      alightOptions: null,
      candidates: [],
      preview: null,
      status: 'error',
      trip: { id: '1:1346665' },
      vehicle: { routeId: '1:904', vehicleId: '1:8140' }
    },
    riding: midRide
      ? { confidence: 'confirmed', routeId: '1:904', tripId: '1:1346665' }
      : null,
    tracking: { ...(otp.goMode?.tracking || {}), lastPosition: null }
  }
  return mockWithProvider(AlightRecommendation, {}, state, messages)
}

/**
 * Backlog 17.17 — "the onboard error card's Cancel ends the live trip".
 *
 * Found 2026-09-17 by the 17.4/17.5 agent while tracing the error state that
 * `bac52687d` had just added to the boarding prompt. The card here is the
 * OTHER error surface: `status === 'error'` in AlightRecommendation, which
 * renders whenever the onboard flow gives up — and the onboard flow is opened
 * mid-ride by `replanFromAboard`, with `onboard.status !== 'idle'` putting the
 * panel over a trip that is still running (GoModeScreen's `onboardActive`
 * branch). Its second button was wired to `endGoMode` UNCONDITIONALLY, so the
 * rider's only non-"Choose bus" way off a card about a failed SEARCH ended the
 * whole TRIP: tracking, itinerary, vehicle lock, notifications.
 *
 * No ride has pressed it — this is a source reading, which is why the row
 * exists rather than a dedupe against 17.4. Verified against otprr main
 * `76f2599c7` before the fix at `AlightRecommendation.tsx:162` (the row quoted
 * `:158`, which was `9aa50ab45`; today's five onboard merges moved it).
 *
 * The asymmetry the fix adopts is not new: `GoModeScreen.tsx:183-188` already
 * routes the header Back button to `clearOnboard` when `activeItinerary`
 * stands and to a confirm-then-end when it does not, and 17.1's preview screen
 * added a third level above both. Pre-trip behaviour is deliberately
 * unchanged.
 */
describe('components > go-mode > onboard error card exit (17.17)', () => {
  describe('mid-ride: the live trip survives', () => {
    it('dispatches CLEAR_ONBOARD and never STOP_GO_MODE', () => {
      const { store, wrapper } = render({ midRide: true })
      wrapper
        .find('button[data-testid="onboard-error-back-to-trip"]')
        .simulate('click')
      const types = store.getActions().map((a: { type: string }) => a.type)
      expect(types).toContain('CLEAR_ONBOARD')
      // The bug, in one assertion: a card about a failed bus search must not
      // be able to end the ride it is drawn on top of.
      expect(types).not.toContain('STOP_GO_MODE')
    })

    it('does not offer a control labelled Cancel at all', () => {
      const { wrapper } = render({ midRide: true })
      // "Cancel" is a promise about scope. Mid-ride there is nothing to
      // cancel — the search already failed — and the trip must not read as
      // the thing being cancelled.
      expect(wrapper.text()).not.toContain('Cancel')
      expect(wrapper.text()).toContain('Back to trip')
      expect(
        wrapper.find('button[data-testid="onboard-error-cancel"]')
      ).toHaveLength(0)
    })

    it('still offers Choose bus beside it', () => {
      const { store, wrapper } = render({ midRide: true })
      const buttons = wrapper.find('button')
      expect(buttons).toHaveLength(2)
      expect(wrapper.text()).toContain('Choose bus')
      // 15.3's deny path, untouched by this row.
      buttons.at(0).simulate('click')
      expect(store.getActions().length).toBeGreaterThan(0)
    })
  })

  describe('pre-trip: Cancel really does mean never mind', () => {
    /**
     * `BEGIN_ONBOARD_FLOW` has already nulled `activeItinerary` here, so there
     * is no trip to go back to and ending Go Mode is the only honest thing the
     * button can do. This test is the guard on the fix, not on the bug: it
     * fails if the mid-ride branch is ever made unconditional.
     */
    it('dispatches STOP_GO_MODE and not CLEAR_ONBOARD', () => {
      const { store, wrapper } = render({ midRide: false })
      wrapper
        .find('button[data-testid="onboard-error-cancel"]')
        .simulate('click')
      const types = store.getActions().map((a: { type: string }) => a.type)
      expect(types).toContain('STOP_GO_MODE')
      expect(types).not.toContain('CLEAR_ONBOARD')
    })

    it('is still labelled Cancel', () => {
      const { wrapper } = render({ midRide: false })
      expect(wrapper.text()).toContain('Cancel')
      expect(wrapper.text()).not.toContain('Back to trip')
    })
  })
})
