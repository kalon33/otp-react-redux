import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'

import coreUtils from '@opentripplanner/core-utils'
import React from 'react'
import yaml from 'js-yaml'

import { AUTO_ARM_STORAGE_KEY } from '../../../lib/util/go-mode/auto-arm'
import { AUTO_PRESET_STORAGE_KEY } from '../../../lib/util/go-mode/auto-switch'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import {
  START_WHEN_I_LEAVE_STYLE,
  StartTripButton
} from '../../../lib/components/narrative/metro/metro-itinerary'
import { stopArmGps } from '../../../lib/util/go-mode/auto-arm-gps'
import AutoArmControl from '../../../lib/components/go-mode/AutoArmControl'
import ReturnToTripBanner from '../../../lib/components/app/return-to-trip-banner'

/**
 * "Start when I leave" (65.2, cycle 36 B4): the arm control, its card with
 * the shared four-preset picker, and the armed strip — with the shipped
 * English copy. With AUTO_SHOTS set to a directory, each state is also
 * written there as a standalone page for a headless Chrome screenshot.
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
  yaml.load(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)

const itinerary: any = {
  endTime: Date.now() + 40 * 60000,
  legs: [
    {
      from: { lat: 44.95, lon: -93.29 },
      mode: 'WALK',
      to: { lat: 44.951, lon: -93.29 }
    },
    {
      from: { lat: 44.951, lon: -93.29 },
      mode: 'BUS',
      route: { id: '1:94' },
      to: { lat: 44.99, lon: -93.25, name: 'Work' },
      transitLeg: true
    }
  ],
  startTime: Date.now()
}

const armedState = (preset = 'leastBike', status = 'armed') => {
  const state = getMockInitialState()
  return {
    ...state,
    otp: {
      ...state.otp,
      goMode: {
        ...state.otp.goMode,
        arm: {
          armedAtMs: Date.UTC(2026, 9, 26, 12, 0),
          expiresAtMs: Date.UTC(2026, 9, 26, 14, 0),
          id: 'arm-1',
          itinerary,
          point: null,
          preset,
          status,
          to: { lat: 44.99, lon: -93.25, name: 'Work' }
        },
        isActive: false
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shot(name: string, wrapper: any) {
  const dir = process.env.AUTO_SHOTS
  if (!dir) return
  // React updates a radio's `checked` property, not its attribute: copy it
  // across so the page shows the state the test asserted.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapper.find('input[type="radio"]').forEach((w: any) => {
    const input = w.getDOMNode() as HTMLInputElement
    if (input.checked) input.setAttribute('checked', '')
    else input.removeAttribute('checked')
  })
  const body = wrapper.html()
  const css = Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent)
    .join('\n')
  writeFileSync(
    path.join(dir, `${name}.html`),
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<style>${css}</style>
<style>
  html, body { margin: 0; font-family: -apple-system, system-ui, sans-serif; }
  .nav { height: 50px; background: #fff; border-bottom: 1px solid #e7e7e7; }
  .frame { position: relative; min-height: 100vh; background: #fff; }
  .itin { padding: 12px 16px; color: #333; font-size: 15px; border-bottom: 1px solid #eee; }
</style></head><body><div class="frame"><div class="nav"></div>
<div class="itin" style="padding-top: calc(12px + var(--return-to-trip-banner-height, 0px))"><b>7:08 AM – 7:40 AM</b> · 32 min<br>Walk · 94 · Walk</div>
${body}</div></body></html>`
  )
}

const Button = ({ onClick }: { onClick: () => void }) => (
  <StartTripButton
    className="start-when-i-leave"
    onClick={onClick}
    style={START_WHEN_I_LEAVE_STYLE}
    type="button"
  >
    Start when I leave
  </StartTripButton>
)

describe('Start when I leave: the arm card (65.2 B4)', () => {
  afterEach(async () => {
    await stopArmGps()
    coreUtils.storage.removeItem(AUTO_ARM_STORAGE_KEY)
    coreUtils.storage.removeItem(AUTO_PRESET_STORAGE_KEY)
  })

  const control = () =>
    mockWithProvider(
      AutoArmControl,
      {
        children: (open: () => void) => <Button onClick={open} />,
        itinerary
      },
      getMockInitialState(),
      messages
    )

  it('opens on the remembered preset; picking then Cancel changes nothing', () => {
    coreUtils.storage.storeItem(AUTO_PRESET_STORAGE_KEY, 'simplest')
    const { store, wrapper } = control()
    wrapper.find('button.start-when-i-leave').simulate('click')
    const card = wrapper.find('.auto-arm-card').hostNodes()
    expect(card.find('h3').text()).toBe('Start when I leave')
    expect(card.find('p').text()).toBe(
      'The trip starts in Auto when you head out. Keep the app open.'
    )
    expect(
      wrapper.find('input[type="radio"]').map((r) => r.prop('checked'))
    ).toEqual([false, false, true, false])
    shot('auto-arm-card', wrapper)
    wrapper.find('input[value="leastBike"]').simulate('change')
    expect(
      wrapper.find('input[type="radio"]').map((r) => r.prop('checked'))
    ).toEqual([false, true, false, false])
    shot('auto-arm-card-picked', wrapper)
    wrapper.find('button.auto-arm-cancel').simulate('click')
    expect(wrapper.find('.auto-arm-card').hostNodes()).toHaveLength(0)
    expect(store.getActions()).toEqual([])
    expect(coreUtils.storage.getItem(AUTO_PRESET_STORAGE_KEY, null)).toBe(
      'simplest'
    )
  })

  it('"Start when I leave" arms with the card’s pick and remembers it', () => {
    const { store, wrapper } = control()
    wrapper.find('button.start-when-i-leave').simulate('click')
    // first use: Fastest
    expect(
      wrapper.find('input[type="radio"]').map((r) => r.prop('checked'))
    ).toEqual([true, false, false, false])
    wrapper.find('input[value="stayOnRoute"]').simulate('change')
    const confirm = wrapper.find('button.auto-arm-confirm')
    expect(confirm.text()).toBe('Start when I leave')
    confirm.simulate('click')
    const arm = store.getActions().find((a: any) => a.type === 'SET_AUTO_ARM')
      ?.payload.arm
    expect(arm).toMatchObject({ preset: 'stayOnRoute', status: 'armed' })
    expect(coreUtils.storage.getItem(AUTO_PRESET_STORAGE_KEY, null)).toBe(
      'stayOnRoute'
    )
  })

  it('armed: the strip on every screen, and the card it opens', () => {
    const { store, wrapper } = mockWithProvider(
      ReturnToTripBanner,
      {},
      armedState('leastBike'),
      messages
    )
    const strip = wrapper.find('button.return-to-trip-banner')
    expect(strip.text()).toBe(
      'Starts when you leave · Auto · Least biking — tap to change'
    )
    shot('auto-arm-banner', wrapper)
    strip.simulate('click')
    const card = wrapper.find('.auto-arm-card').hostNodes()
    expect(card.find('p').text()).toMatch(/^Waiting for you to leave · until /)
    expect(card.find('button.auto-arm-cancel').text()).toBe("Don't start")
    expect(card.find('button.auto-arm-confirm').text()).toBe('OK')
    expect(
      wrapper.find('input[type="radio"]').map((r) => r.prop('checked'))
    ).toEqual([false, true, false, false])
    shot('auto-arm-armed-card', wrapper)
    // a pick on the armed card applies at once
    wrapper.find('input[value="fastest"]').simulate('change')
    expect(
      store.getActions().find((a: any) => a.type === 'SET_AUTO_ARM')?.payload
    ).toMatchObject({ id: 'arm-1', preset: 'fastest' })
    wrapper.find('button.auto-arm-cancel').simulate('click')
    expect(
      store.getActions().find((a: any) => a.type === 'CLEAR_AUTO_ARM')?.payload
    ).toMatchObject({ id: 'arm-1', why: 'rider' })
  })

  it('starting: the strip says so', () => {
    const { wrapper } = mockWithProvider(
      ReturnToTripBanner,
      {},
      armedState('fastest', 'starting'),
      messages
    )
    expect(wrapper.find('button.return-to-trip-banner').text()).toBe(
      'Starting your trip…'
    )
  })
})
