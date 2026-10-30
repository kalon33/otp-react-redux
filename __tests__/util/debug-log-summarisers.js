import fs from 'fs'
import path from 'path'

import { PAYLOAD_SUMMARISERS } from '../../lib/util/debug-log-summarisers'
import FULL_CAPTURE_TYPE_LIST from '../../lib/util/full-capture-types.json'

// debug-log.js itself cannot be imported here (its import.meta is unparseable
// by Jest), so its wiring is checked against the source the same way
// debug-log-entry.js and debug-log-ladder.js do.
const source = fs.readFileSync(
  path.join(__dirname, '../../lib/util/debug-log.js'),
  'utf8'
)

describe('util > debug-log per-action summarisers', () => {
  it('summarises UPDATE_LOCALE to the locale and the catalogue size', () => {
    // The real payload: the flattened catalogue, measured at 76,334-76,856
    // chars on 2026-09-15 (backlog 17.13).
    const messages = {}
    for (let i = 0; i < 770; i++) messages[`components.Thing.key${i}`] = 'x'
    expect(
      PAYLOAD_SUMMARISERS.UPDATE_LOCALE({ locale: 'fr', messages })
    ).toEqual({
      __summary: true,
      locale: 'fr',
      messageCount: 770
    })
  })

  it('records something small — the point of the row', () => {
    const messages = {}
    for (let i = 0; i < 770; i++) {
      messages[`components.Thing.key${i}`] = 'a translated string of some size'
    }
    const payload = { locale: 'fr', messages }
    const summary = PAYLOAD_SUMMARISERS.UPDATE_LOCALE(payload)
    expect(JSON.stringify(payload).length).toBeGreaterThan(30000)
    expect(JSON.stringify(summary).length).toBeLessThan(100)
  })

  it('survives a payload that is not the shape it expects', () => {
    expect(() => PAYLOAD_SUMMARISERS.UPDATE_LOCALE(undefined)).not.toThrow()
    expect(PAYLOAD_SUMMARISERS.UPDATE_LOCALE({})).toEqual({
      __summary: true,
      locale: undefined,
      messageCount: undefined
    })
    expect(
      PAYLOAD_SUMMARISERS.UPDATE_LOCALE({ locale: 'fr', messages: 'nope' })
    ).toEqual({ __summary: true, locale: 'fr', messageCount: undefined })
  })

  it('never summarises a full-capture type', () => {
    // A summariser wins over full capture in summarisePayload, so listing a
    // whitelisted type here would silently make recorded trips unreplayable.
    const overlap = Object.keys(PAYLOAD_SUMMARISERS).filter((type) =>
      FULL_CAPTURE_TYPE_LIST.includes(type)
    )
    expect(overlap).toEqual([])
  })

  it('is consulted before the payload is stringified', () => {
    // The saving is the stringify itself, so the dispatch has to sit ABOVE the
    // JSON.stringify in summarisePayload, not below it.
    const dispatch = source.indexOf('PAYLOAD_SUMMARISERS, action.type')
    const stringify = source.indexOf('json = JSON.stringify(payload)')
    expect(dispatch).toBeGreaterThan(-1)
    expect(stringify).toBeGreaterThan(-1)
    expect(dispatch).toBeLessThan(stringify)
  })

  it('leaves every payload ceiling alone (backlog 17.10)', () => {
    expect(source).toContain('const MAX_PAYLOAD_CHARS = 4000')
    expect(source).toContain('const MAX_FULL_PAYLOAD_CHARS = 1000000')
  })
})

describe('util > debug-log SET_ACTIVE_ITINERARY summariser (17.13 P4)', () => {
  /** The real shape: a merged itinerary that points back at itself. */
  function cyclicItinerary() {
    const legs = Array.from({ length: 4 }, (_, i) => ({
      geometry: 'g'.repeat(25000),
      mode: i % 2 ? 'BUS' : 'WALK',
      routeId: i % 2 ? `1:route${i}` : undefined
    }))
    const itinerary = {
      endTime: 1761750900000,
      index: 3,
      key: 'k-abc',
      legs,
      startTime: 1761749000000
    }
    itinerary.allStartTimes = [{ itinerary }]
    return itinerary
  }

  it('records index, key, times, leg count and route ids', () => {
    expect(PAYLOAD_SUMMARISERS.SET_ACTIVE_ITINERARY(cyclicItinerary())).toEqual(
      {
        __summary: true,
        endTime: 1761750900000,
        index: 3,
        key: 'k-abc',
        legCount: 4,
        routeIds: ['1:route1', '1:route3'],
        startTime: 1761749000000
      }
    )
  })

  it('never stringifies the payload', () => {
    const payload = cyclicItinerary()
    const spy = jest.spyOn(JSON, 'stringify')
    let out
    try {
      out = PAYLOAD_SUMMARISERS.SET_ACTIVE_ITINERARY(payload)
    } finally {
      const calls = spy.mock.calls.length
      spy.mockRestore()
      expect(calls).toBe(0)
    }
    // Small, and (unlike the payload) serialisable.
    expect(JSON.stringify(out).length).toBeLessThan(300)
  })

  it('survives an index-only or empty payload', () => {
    expect(() =>
      PAYLOAD_SUMMARISERS.SET_ACTIVE_ITINERARY(undefined)
    ).not.toThrow()
    expect(PAYLOAD_SUMMARISERS.SET_ACTIVE_ITINERARY({ index: -1 })).toEqual({
      __summary: true,
      endTime: undefined,
      index: -1,
      key: undefined,
      legCount: undefined,
      routeIds: undefined,
      startTime: undefined
    })
  })
})
