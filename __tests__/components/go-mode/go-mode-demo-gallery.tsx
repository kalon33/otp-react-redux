import '../../test-utils/mock-window-url'
import Enzyme, { mount } from 'enzyme'
import EnzymeReactAdapter from 'enzyme-adapter-react-16'
import React from 'react'

import { groupAlightOptionsByRoute } from '../../../lib/util/go-mode/alight-optimizer'
import GoModeDemo from '../../../lib/components/go-mode/GoModeDemo'

Enzyme.configure({ adapter: new EnzymeReactAdapter() })

/**
 * The `?goModeDemo=1` gallery is the only way a Go Mode card gets reviewed or
 * screenshotted without a live ride, and it was dead from 2026-09-02 (when 3.7
 * shipped the onboard grouping, `7dc13053`) to 2026-09-04: its `readyOnboard`
 * fixture built alight options with no `itinerary.legs`, so
 * `transitRouteSignature` threw inside `groupAlightOptionsByRoute`. With no
 * error boundary above GoModeDemo the whole page unmounted — the trip sheet
 * included, which is why 8.9's chip could only be covered by mounted tests.
 *
 * Nothing but a mount of the whole gallery catches that, because the fixture
 * and the components it feeds are the thing under test. Backlog 8.12.
 */
describe('components > go-mode > GoModeDemo gallery', () => {
  it('mounts every card without throwing', () => {
    const wrapper = mount(<GoModeDemo />)
    expect(wrapper.text()).toContain('Go Mode — card gallery')
    // Every Frame renders its title; the last one is below the onboard frame
    // that used to take the page down.
    expect(wrapper.text()).toContain('Trip sheet (overview + search from here)')
  })

  it('renders the onboard options list, not an empty frame', () => {
    const wrapper = mount(<GoModeDemo />)
    // Two alight frames (LIVE + SCHEDULED), each grouping three options into
    // two rows: 21 alone, and the two 21 > 6 variants stacked.
    expect(wrapper.find('li.result').length).toBe(4)
    expect(wrapper.text()).toContain('Off at Nicollet Mall')
    expect(wrapper.text()).toContain('Off at Government Plaza')
  })

  it('stacks the two same-route options behind a drill-down', () => {
    const wrapper = mount(<GoModeDemo />)
    const toggles = wrapper.find('button.same-shape-variants-toggle')
    expect(toggles.length).toBe(2)
    expect(toggles.at(0).text()).toBe('2 options')
  })
})

/**
 * The fixture-level half of the same guard: whatever the gallery hands the list
 * has to survive the grouping on its own, so a future edit to the fixture that
 * drops `legs` fails here with a readable message rather than as a blank page.
 */
describe('util > go-mode > transitRouteSignature tolerance', () => {
  it('gives a legless itinerary the empty signature instead of throwing', () => {
    const groups = groupAlightOptionsByRoute([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { itinerary: {} } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { itinerary: {} } as any
    ])
    // Two empty signatures never merge — the contract on transitRouteSignature.
    expect(groups.length).toBe(2)
    expect(groups[0].variants.length).toBe(1)
  })
})
