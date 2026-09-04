import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import { mockWithProvider } from '../../test-utils/mock-data/store'
import WalkingNavigation from '../../../lib/components/go-mode/WalkingNavigation'

/**
 * Jest maps i18n/*.yml to an empty object, so an import would give us nothing.
 * Read and flatten the shipped English file instead — the copy the assertions
 * below check is then literally the copy that goes to the phone.
 */
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

/**
 * Backlog 9.2, rider ask 2026-09-04 15:08:30 with a screenshot: three
 * `Next: 3:29 PM (21 min away) / Use this` rows took about a third of the card
 * while the rider's next action was a 208 ft turn.
 *
 * Stop-time and leg shapes are the same ones lib/components/go-mode/GoModeDemo
 * hands this card in the `?goModeDemo=1` gallery, so the rendering asserted
 * here is the rendering that gallery shows.
 */
const NOW = 1_788_537_600_000
const SERVICE_DAY = Math.floor(NOW / 1000) - 4 * 3600

const stoptime = (depInMs: number, realtime: boolean) => {
  const depSecs = Math.round((NOW + depInMs) / 1000) - SERVICE_DAY
  return {
    headsign: 'Downtown',
    realtimeDeparture: realtime ? depSecs : null,
    realtimeState: realtime ? 'UPDATED' : 'SCHEDULED',
    scheduledDeparture: depSecs,
    serviceDay: SERVICE_DAY,
    trip: {
      blockId: 'b1',
      pattern: { id: '1:21:0' },
      route: { gtfsId: '1:21' }
    }
  }
}

const boardingStopData = {
  gtfsId: '1:1001',
  name: 'Lake St & Hennepin Ave',
  routes: [{ id: '1:21' }],
  stoptimesForPatterns: [
    {
      pattern: {
        desc: '21 to Downtown',
        id: '1:21:0',
        route: { gtfsId: '1:21' }
      },
      stoptimes: [
        stoptime(7 * 60000, true), // the targeted bus
        stoptime(19 * 60000, true),
        stoptime(31 * 60000, false),
        stoptime(43 * 60000, true)
      ]
    }
  ]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const walkLeg: any = {
  duration: 360,
  from: { name: 'Your location' },
  mode: 'WALK',
  to: { name: 'Lake St & Hennepin Ave' }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const busNextLeg: any = {
  from: { name: 'Lake St & Hennepin Ave', stop: { gtfsId: '1:1001' } },
  mode: 'BUS',
  route: { id: '1:21' },
  routeShortName: '21',
  transitLeg: true
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const progress: any = {
  currentLegIndex: 0,
  currentLegProgress: 0,
  currentTime: new Date(NOW),
  estimatedArrival: new Date(NOW + 25 * 60000),
  overallProgress: 10,
  plannedDepartureTime: NOW + 8 * 60000,
  status: 'onTime',
  timeRemaining: 1500,
  timeUntilNextDeparture: 420
}

function renderCard(onSelectDeparture = jest.fn()) {
  const { wrapper } = mockWithProvider(
    WalkingNavigation,
    {
      boardingStopData,
      leg: walkLeg,
      nextLeg: busNextLeg,
      onSelectDeparture,
      progress
    },
    undefined,
    messages
  )
  return { onSelectDeparture, wrapper }
}

/** The list's rows are the ones carrying a "Use this" button. */
const useThisButtons = (wrapper: any) =>
  wrapper.findWhere(
    (n: any) => n.type() === 'button' && n.text() === 'Use this'
  )

const toggle = (wrapper: any) =>
  wrapper.findWhere(
    (n: any) => n.type() === 'button' && /^[▾▴] (More|Less)$/.test(n.text())
  )

describe('components > go-mode > later departures (backlog 9.2)', () => {
  it('collapses to the next departure alone, with no Use-this rows', () => {
    const { wrapper } = renderCard()
    expect(useThisButtons(wrapper)).toHaveLength(0)
    // The one line the rider asked to keep: the next departure time.
    expect(wrapper.text()).toContain('min away)')
    expect(toggle(wrapper).text()).toBe('▾ More')
    expect(toggle(wrapper).prop('aria-expanded')).toBe(false)
    // One summary line, not three departures.
    expect(wrapper.text().match(/min away\)/g)).toHaveLength(1)
  })

  it('expands to today’s list, each row still offering Use this', () => {
    const { wrapper } = renderCard()
    toggle(wrapper).simulate('click')
    wrapper.update()
    // Three later departures follow the targeted 7-minute bus.
    expect(useThisButtons(wrapper)).toHaveLength(3)
    expect(wrapper.text()).toContain('Later departures')
    expect(toggle(wrapper).text()).toBe('▴ Less')
    expect(toggle(wrapper).prop('aria-expanded')).toBe(true)
    expect(wrapper.find('#go-mode-later-departures').hostNodes()).toHaveLength(
      1
    )
    expect(toggle(wrapper).prop('aria-controls')).toBe(
      'go-mode-later-departures'
    )
  })

  it('collapses again on a second tap', () => {
    const { wrapper } = renderCard()
    toggle(wrapper).simulate('click')
    wrapper.update()
    toggle(wrapper).simulate('click')
    wrapper.update()
    expect(useThisButtons(wrapper)).toHaveLength(0)
    expect(toggle(wrapper).text()).toBe('▾ More')
  })

  it('keeps the chosen-departure semantics: Use this still names its own time', () => {
    const { onSelectDeparture, wrapper } = renderCard()
    toggle(wrapper).simulate('click')
    wrapper.update()
    useThisButtons(wrapper).at(1).simulate('click')
    expect(onSelectDeparture).toHaveBeenCalledTimes(1)
    // Second later departure = the 31-minute scheduled one.
    const chosen = onSelectDeparture.mock.calls[0][0]
    expect(Math.round((chosen - NOW) / 60000)).toBe(31)
  })

  it('opens collapsed on every mount', () => {
    const { wrapper } = renderCard()
    toggle(wrapper).simulate('click')
    wrapper.update()
    expect(useThisButtons(wrapper)).toHaveLength(3)
    const fresh = renderCard().wrapper
    expect(useThisButtons(fresh)).toHaveLength(0)
  })
})
