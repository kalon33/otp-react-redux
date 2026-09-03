import fs from 'fs'
import path from 'path'

import {
  createEntryIdMinter,
  ENTRY_ID_PATTERN,
  measureEntry,
  UNMEASURABLE_ENTRY_CHARS
} from '../../lib/util/debug-log-entry'

// debug-log.js itself cannot be imported here (its import.meta is unparseable
// by Jest), so its wiring is checked against the source the same way
// debug-log-ladder.js checks the size ceilings.
const source = fs.readFileSync(
  path.join(__dirname, '../../lib/util/debug-log.js'),
  'utf8'
)

describe('util > debug-log entry ids', () => {
  it('mints a distinct id per entry within a session', () => {
    const mint = createEntryIdMinter('mtbtyif4-axo9cm')
    const ids = Array.from({ length: 1000 }, mint)
    expect(new Set(ids).size).toBe(1000)
  })

  it('scopes ids to the session so two devices cannot collide', () => {
    // The counter is only unique WITHIN a session; the session id is what makes
    // it unique across devices and app starts. Two sessions minting their first
    // entry at the same instant must still produce different ids.
    const a = createEntryIdMinter('mtbtyif4-axo9cm')()
    const b = createEntryIdMinter('mtbtyif4-zzzzzz')()
    expect(a).not.toEqual(b)
    expect(a.startsWith('mtbtyif4-axo9cm')).toBe(true)
  })

  it('produces ids the sink will accept as identifying', () => {
    // The server holds ids to the identical pattern and treats anything else as
    // un-identified — written, never deduped. An id shape the sink rejects
    // would silently reinstate the duplicates this whole change exists to end.
    const mint = createEntryIdMinter('mtbtyif4-axo9cm')
    for (let i = 0; i < 500; i++) expect(mint()).toMatch(ENTRY_ID_PATTERN)
  })

  it('still mints usable ids when the session id is unusable', () => {
    // Storage/URL quirks have produced odd session values before; an id with a
    // space or a newline in it would corrupt the sink's line-delimited index.
    const mint = createEntryIdMinter('has space\nand newline')
    expect(mint()).toMatch(ENTRY_ID_PATTERN)
  })

  it('measures an entry, and charges an unmeasurable one rather than zero', () => {
    const entry = { kind: 'action', type: 'UPDATE_POSITION' }
    expect(measureEntry(entry)).toBe(JSON.stringify(entry).length)
    const cyclic = { kind: 'action' }
    cyclic.self = cyclic
    // Free would let unmeasurable entries defeat the byte cap entirely.
    expect(measureEntry(cyclic)).toBe(UNMEASURABLE_ENTRY_CHARS)
  })
})

describe('util > debug-log idempotency wiring', () => {
  it('stamps the id in push(), not at flush time', () => {
    // The whole fix. flush() only splices on a RESOLVED fetch and flushBeacon
    // never splices at all, so an entry legitimately reaches the sink more than
    // once; measured at 1.8-4.8% of records a day across 2026-08-27..08-31. An
    // id minted per POST would be a different id on the retry and would dedupe
    // nothing, so it must be minted where the entry is created.
    const push = source.slice(
      source.indexOf('function push(entry)'),
      source.indexOf('export function recordSessionEvent')
    )
    // The minter itself now lives in debug-log-boot.js, so that a boot crash
    // beacon sent before this module has even evaluated draws from the SAME
    // dense counter under the SAME session id. Where it is CALLED is the
    // invariant, and it is unchanged.
    expect(push).toMatch(/entry\.id = mintBootEntryId\(\)/)
    // ...and nowhere else: not in flush, buildBatch or flushBeacon.
    expect(source.match(/mintBootEntryId\(\)/g)).toHaveLength(1)
  })

  it('bounds the buffer by bytes as well as by entry count', () => {
    // 400 entries was a memory bound when every entry was capped at 4k. A
    // recorded trip now admits 1,000,000-char payloads, which makes the same
    // 400 entries worth ~400 MB on a phone that gets killed for far less.
    const cap = Number(source.match(/^const MAX_BUFFER_BYTES = (\d+)/m)?.[1])
    const full = Number(
      source.match(/^const MAX_FULL_PAYLOAD_CHARS = (\d+)/m)?.[1]
    )
    expect(cap).toBeGreaterThan(full) // one full-capture entry must still fit
    expect(cap).toBeLessThan(400 * full) // ...but 400 of them must not
    expect(source).toMatch(/bufferChars > MAX_BUFFER_BYTES/)
  })

  it('keeps the byte total honest through every removal', () => {
    // A total that drifts from the buffer's contents either evicts a live
    // stream to nothing or stops capping at all, and both fail silently.
    expect(source.match(/buffer\.splice\(/g)).toHaveLength(1)
    expect(source).toMatch(/function dropFromFront\(n\)/)
    expect(source).toMatch(/dropFromFront\(batch\.length\)/)
  })

  it('does not start a second flush while one is in flight', () => {
    // The 3s interval firing over a slow upload re-sends the same unspliced
    // prefix — duplicated uplink on cellular, with bodies now up to 1.4 MB.
    expect(source).toMatch(/now - inFlightSince < INFLIGHT_TIMEOUT_MS/)
    // ...but the guard must expire, or one fetch that never settles wedges the
    // logger for the rest of the ride.
    const timeout = Number(
      source.match(/^const INFLIGHT_TIMEOUT_MS = (\d+)/m)?.[1]
    )
    const interval = Number(
      source.match(/^const FLUSH_INTERVAL_MS = (\d+)/m)[1]
    )
    expect(timeout).toBeGreaterThan(interval)
    expect(timeout).toBeLessThanOrEqual(60000)
  })
})
