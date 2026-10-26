import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { readFileSync, writeFileSync } from 'fs'
import path from 'path'

import React from 'react'
import yaml from 'js-yaml'

import { AUTO_OFF } from '../../../lib/util/go-mode/auto-switch'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import AutoSwitchCard from '../../../lib/components/go-mode/AutoSwitchCard'
import AutoToggle from '../../../lib/components/go-mode/AutoToggle'
import type { AutoUndo } from '../../../lib/util/go-mode/auto-switch'

/**
 * Backlog 65.2, cycle 36 B2 — the Auto chip, its preset sheet and the Undo
 * card, with the shipped English copy (i18n/en-US.yml, flattened, as the
 * round-trip card's test does).
 *
 * With AUTO_SHOTS set to a directory, each state is also written there as a
 * standalone HTML page (styled-components' CSS + the markup) for a headless
 * Chrome screenshot.
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

const stateWith = (auto: any) => {
  const state = getMockInitialState()
  return {
    ...state,
    otp: {
      ...state.otp,
      goMode: { ...state.otp.goMode, auto, isActive: true }
    }
  }
}

const undo: AutoUndo = {
  aboard: false,
  addedBikeM: 0,
  bikeSavedM: 0,
  changesSaved: 0,
  expiresAtMs: Date.now() + 5 * 60000,
  fromItinerary: { legs: [] } as any,
  fromRouteSet: '1:A',
  headline: 'faster',
  laterMs: 0,
  preset: 'fastest',
  routeLabel: '14',
  savingMs: 6 * 60000,
  switchId: 'as-1',
  toRouteSet: '1:14'
}

/** One shot page: a 390 px phone frame with a map-coloured area. */
function shot(name: string, body: string) {
  const dir = process.env.AUTO_SHOTS
  if (!dir) return
  const css = Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent)
    .join('\n')
  writeFileSync(
    path.join(dir, `${name}.html`),
    `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=390">
<style>${css}</style>
<style>
  html, body { margin: 0; font-family: -apple-system, system-ui, sans-serif; }
  .frame { position: relative; width: 100vw; height: 100vh; overflow: hidden;
    background: #e8eadf; }
  .panel { height: 150px; background: #fff; border-bottom: 1px solid #ddd;
    padding: 16px; box-sizing: border-box; color: #333; font-size: 15px; }
  .map { position: relative; height: calc(100vh - 150px);
    background: repeating-linear-gradient(45deg, #e4e7d9, #e4e7d9 20px, #dde1d0 20px, #dde1d0 40px); }
  .handle { position: absolute; bottom: 0; left: 50%; transform: translateX(-50%);
    background: #fff; border-radius: 14px 14px 0 0; padding: 18px 32px 10px;
    color: #2196f3; font-size: 13px; font-weight: 600; white-space: nowrap;
    box-shadow: 0 -2px 12px rgba(0,0,0,.15); }
  .follow { position: absolute; top: 10px; left: 10px; width: 29px; height: 29px;
    background: #fff; border-radius: 4px; box-shadow: 0 0 0 2px rgba(0,0,0,.1); }
</style></head><body><div class="frame"><div class="panel">Bike to 6th St S &amp; Park Ave · 2.1 km</div>
<div class="map"><div class="follow"></div><div class="handle">View trip &amp; other ways</div>${body}</div></div></body></html>`
  )
}

describe('Auto chip, preset sheet and Undo card (65.2 B2)', () => {
  it('off: reads "Auto"; one tap turns it on (no sheet)', () => {
    const { store, wrapper } = mockWithProvider(
      AutoToggle,
      {},
      stateWith(AUTO_OFF),
      messages
    )
    const chip = wrapper.find('button.auto-toggle')
    expect(chip.text()).toBe('Auto')
    expect(chip.prop('aria-pressed')).toBe(false)
    shot('auto-chip-off', wrapper.html())
    chip.simulate('click')
    expect(store.getActions().map((a: any) => a.type)).toContain(
      'SET_AUTO_MODE'
    )
    expect(
      store.getActions().find((a: any) => a.type === 'SET_AUTO_MODE').payload
    ).toMatchObject({ on: true, preset: 'fastest' })
    expect(wrapper.find('input[type="radio"]')).toHaveLength(0)
  })

  it('on: reads "Auto · Fastest" and opens the four-preset sheet', () => {
    const { store, wrapper } = mockWithProvider(
      AutoToggle,
      {},
      stateWith({ ...AUTO_OFF, on: true }),
      messages
    )
    const chip = wrapper.find('button.auto-toggle')
    expect(chip.text()).toBe('Auto · Fastest')
    shot('auto-chip-on', wrapper.html())
    chip.simulate('click')
    const rows = wrapper.find('label.auto-preset-row')
    expect(rows.map((r) => r.text())).toEqual([
      'Fastest3+ min sooner, or 1 km+ less biking',
      'Least biking1 km+ less biking, up to 2 min later',
      'SimplestFewer transfers, up to 2 min later',
      'Stay on my routeOnly earlier buses on your route'
    ])
    expect(
      wrapper.find('input[type="radio"]').map((r) => r.prop('checked'))
    ).toEqual([true, false, false, false])
    shot('auto-preset-sheet', wrapper.html())
    wrapper.find('input[value="leastBike"]').simulate('change')
    expect(
      store.getActions().filter((a: any) => a.type === 'SET_AUTO_MODE')[0]
        .payload
    ).toMatchObject({ on: true, preset: 'leastBike', source: 'sheet' })
  })

  it('the sheet turns Auto off', () => {
    const { store, wrapper } = mockWithProvider(
      AutoToggle,
      {},
      stateWith({ ...AUTO_OFF, on: true, preset: 'simplest' }),
      messages
    )
    expect(wrapper.find('button.auto-toggle').text()).toBe('Auto · Simplest')
    wrapper.find('button.auto-toggle').simulate('click')
    const off = wrapper.findWhere(
      (n) => n.type() === 'button' && n.text() === 'Turn off Auto'
    )
    off.simulate('click')
    expect(
      store.getActions().find((a: any) => a.type === 'SET_AUTO_MODE').payload
    ).toMatchObject({ on: false, preset: 'simplest' })
  })

  it('the Undo card: "Switched · 6 min faster" / "14", OK and Undo', () => {
    const { wrapper } = mockWithProvider(
      AutoSwitchCard,
      {},
      stateWith({ ...AUTO_OFF, on: true, switches: 1, undo }),
      messages
    )
    const card = wrapper.find('.auto-switch-card').hostNodes()
    expect(card.text()).toBe('Switched · 6 min faster14OKUndo')
    shot('auto-undo-card', wrapper.html())
  })

  it('renders nothing with no switch to undo', () => {
    const { wrapper } = mockWithProvider(
      AutoSwitchCard,
      {},
      stateWith(AUTO_OFF),
      messages
    )
    expect(wrapper.html()).toBe('')
  })
})
