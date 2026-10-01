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
