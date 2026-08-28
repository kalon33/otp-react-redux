import fs from 'fs'
import path from 'path'

import FULL_CAPTURE_TYPES from '../../lib/util/full-capture-types.json'

// The recorder (lib/util/debug-log.js, ESM) and the fixture builder
// (lib/util/go-mode/replay/build-fixture.js, CommonJS) must agree exactly on
// which payloads are captured in full. They used to keep separate copies, and
// by 2026-08-27 the copies had drifted three types apart — the recorder stored
// payloads the fixture builder never looked for, so a fixture could report
// itself complete while missing data it has slots for. Sharing one JSON file
// makes that impossible; these tests guard the wiring that makes it so.
//
// debug-log.js cannot be imported here (its import.meta is unparseable by
// Jest — see the note beside MAX_PAYLOAD_CHARS), which is exactly why the
// shared list is a separate data file rather than an export.
describe('util > full-capture-types', () => {
  it('is a non-empty list of unique action types', () => {
    expect(Array.isArray(FULL_CAPTURE_TYPES)).toBe(true)
    expect(FULL_CAPTURE_TYPES.length).toBeGreaterThan(0)
    expect(new Set(FULL_CAPTURE_TYPES).size).toBe(FULL_CAPTURE_TYPES.length)
    FULL_CAPTURE_TYPES.forEach((type) => {
      expect(typeof type).toBe('string')
      expect(type).toMatch(/^[A-Z][A-Z0-9_]*$/)
    })
  })

  it('carries every payload a fixture cannot be built without', () => {
    // Dropping any of these silently produces a fixture that replays the wrong
    // trip rather than failing loudly, so they are pinned by name.
    const required = [
      'START_GO_MODE',
      'ROUTING_RESPONSE',
      'REALTIME_VEHICLE_POSITIONS_RESPONSE',
      'FIND_STOP_TIMES_FOR_STOP_RESPONSE',
      'FIND_TRIP_RESPONSE'
    ]
    required.forEach((type) => expect(FULL_CAPTURE_TYPES).toContain(type))
  })

  it('carries the onboard and reroute inputs that drifted out of the copy', () => {
    const drifted = [
      'STOP_GO_MODE',
      'REROUTE_SNAPSHOT',
      'SET_ONBOARD_TRIP',
      'SET_ONBOARD_RESULT',
      'ONBOARD_CANDIDATE_SNAPSHOT'
    ]
    drifted.forEach((type) => expect(FULL_CAPTURE_TYPES).toContain(type))
  })

  // Guards the wiring rather than the data: if either consumer goes back to a
  // hand-kept literal, the shared file stops meaning anything.
  it('is the single source both consumers read', () => {
    const read = (p) =>
      fs.readFileSync(path.join(__dirname, '../../', p), 'utf8')

    const recorder = read('lib/util/debug-log.js')
    expect(recorder).toContain("from './full-capture-types.json'")
    expect(recorder).toContain('new Set(FULL_CAPTURE_TYPE_LIST)')

    const builder = read('lib/util/go-mode/replay/build-fixture.js')
    expect(builder).toContain("require('../../full-capture-types.json')")
    // No re-introduced literal list beside the require.
    expect(builder).not.toMatch(/FULL_PAYLOAD_TYPES\s*=\s*\[/)
  })
})
