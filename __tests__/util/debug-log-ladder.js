import fs from 'fs'
import path from 'path'

// The record path's size ceilings are FOUR caps in THREE repos and they only
// work if they stay strictly increasing. Two of them live in debug-log.js and
// are guarded here; the full cross-repo ladder (adding transitnav's
// DEBUG_LOG_MAX_LINE_CHARS and the nginx client_max_body_size in BOTH of
// otp-minneapolis's nginx copies) is checked by
// otp-minneapolis/scripts/check-config-ladder.py, which the nightly runs.
//
// This file exists because raising one cap alone does not remove the loss, it
// relocates it — and the symptom is a payload stub nobody notices for weeks.
//
// debug-log.js cannot be imported here (its import.meta is unparseable by
// Jest), so the constants are read out of the source, the same way
// full-capture-types.js checks that file's wiring.
const source = fs.readFileSync(
  path.join(__dirname, '../../lib/util/debug-log.js'),
  'utf8'
)

const constant = (name) => {
  const m = source.match(new RegExp(`^const ${name} = (\\d+)\\b`, 'm'))
  expect(m).not.toBeNull()
  return Number(m[1])
}

describe('util > debug-log size ladder', () => {
  it('keeps the two in-file rungs strictly increasing', () => {
    // A single full-capture payload must fit in a flush body with room for the
    // batch wrapper, or every oversized entry is posted alone and 413'd — and
    // fetch() RESOLVES a 413, so flush() splices the batch away. Data uploaded
    // in full and then discarded is strictly worse than data stubbed cheaply.
    expect(constant('MAX_FULL_PAYLOAD_CHARS')).toBeLessThan(
      constant('MAX_BODY_BYTES')
    )
    // The ordinary (non-recording) cap stays far below the recording one; it is
    // what keeps a normal session's uploads small.
    expect(constant('MAX_PAYLOAD_CHARS')).toBeLessThan(
      constant('MAX_FULL_PAYLOAD_CHARS')
    )
  })

  it('clears the largest full-capture payload real rides have produced', () => {
    // Measured from ~/otp-debug-logs. Every payload a recorded Go Mode trip
    // lost to the summary stub is in here; the ceiling has to clear the worst
    // of them or that ride cannot be replayed:
    //
    //   2026-08-27  54 losses, largest 414,240 (REROUTE_SNAPSHOT)
    //   2026-08-28  30 losses, largest 865,300 (REROUTE_SNAPSHOT, evening ride
    //               mtdh67f3-0z5p24) — four reroutes unreproducible
    //
    // 320,000 was the value that lost them. Pinning the observed maximum means
    // the next ride that outgrows the ceiling fails a test instead of quietly
    // producing an unreplayable fixture days later.
    const LARGEST_OBSERVED = 865300
    expect(constant('MAX_FULL_PAYLOAD_CHARS')).toBeGreaterThan(LARGEST_OBSERVED)
  })

  it('leaves the beacon cap out of the ladder', () => {
    // BEACON_MAX_BODY_BYTES is not a rung. It is the browser's own ~64KB
    // sendBeacon quota: a larger beacon is dropped silently and the tail of the
    // session is lost. Raising it with the ladder would break page-hide flushes
    // rather than help them.
    expect(constant('BEACON_MAX_BODY_BYTES')).toBeLessThan(64 * 1024)
  })

  it('still warns on the ride when a payload is stubbed', () => {
    // Added in 16a93a42. Silently stubbing a whitelisted type is how two rides
    // on 2026-08-27 became unreplayable without anyone noticing until
    // build-fixture.js refused, days later. The ride is the only moment this is
    // still cheap to fix, so the warning must name the action type and say the
    // trip will not be replayable.
    const warn = source.match(/console\.warn\(([\s\S]{0,400}?)\)\n/)
    expect(warn).not.toBeNull()
    expect(warn[1]).toContain('action.type')
    expect(warn[1]).toContain('MAX_FULL_PAYLOAD_CHARS')
    expect(warn[1]).toMatch(/NOT be replayable/)
  })
})
