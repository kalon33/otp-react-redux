/* globals describe, expect, it */
import {
  generateModeSubsets,
  toPlanModesInput
} from '../../lib/util/plan-combinations'

/**
 * planConnection's mode enums are per-slot: the same street mode may be a
 * legal access mode but an invalid transfer mode, and naming an invalid enum
 * value rejects the WHOLE query (measured on the live server: a FLEX +
 * transit search died with "Invalid input for enum 'PlanTransferMode'. No
 * value found for name 'FLEX'"). These tests pin the mapping against the
 * schema's enum values.
 */
describe('util > plan-combinations > toPlanModesInput', () => {
  it('never puts a non-transfer mode into transfer', () => {
    // FLEX is a legal access/egress mode but NOT a PlanTransferMode.
    const input = toPlanModesInput([
      { mode: 'TRANSIT' },
      { mode: 'FLEX' }
    ])
    expect(input).toEqual({
      transit: { access: ['FLEX'], egress: ['FLEX'], transfer: [] },
      transitOnly: true
    })
  })

  it('keeps BICYCLE as access, egress and transfer', () => {
    expect(
      toPlanModesInput([{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }])
    ).toEqual({
      transit: {
        access: ['BICYCLE'],
        egress: ['BICYCLE'],
        transfer: ['BICYCLE']
      },
      transitOnly: true
    })
  })

  it('maps a rented bike to BICYCLE_RENTAL access, no transfer', () => {
    expect(
      toPlanModesInput([
        { mode: 'TRANSIT' },
        { mode: 'BICYCLE', qualifier: 'RENT' }
      ])
    ).toEqual({
      transit: {
        access: ['BICYCLE_RENTAL'],
        egress: ['BICYCLE_RENTAL'],
        transfer: []
      },
      transitOnly: true
    })
  })

  it('walks egress out of a car park-and-ride', () => {
    expect(
      toPlanModesInput([{ mode: 'TRANSIT' }, { mode: 'CAR' }])
    ).toEqual({
      transit: {
        access: ['CAR_PARKING'],
        egress: ['WALK'],
        transfer: []
      },
      transitOnly: true
    })
  })

  it('keeps CAR_RENTAL egress, no transfer', () => {
    // CAR_RENTAL is a valid PlanEgressMode; only the transfer slot is closed.
    expect(
      toPlanModesInput([
        { mode: 'TRANSIT' },
        { mode: 'CAR', qualifier: 'RENT' }
      ])
    ).toEqual({
      transit: {
        access: ['CAR_RENTAL'],
        egress: ['CAR_RENTAL'],
        transfer: []
      },
      transitOnly: true
    })
  })

  it('sends a street-only subset as a direct mode', () => {
    expect(toPlanModesInput([{ mode: 'BICYCLE' }])).toEqual({
      direct: ['BICYCLE'],
      directOnly: true
    })
    expect(toPlanModesInput([{ mode: 'FLEX' }])).toEqual({
      direct: ['FLEX'],
      directOnly: true
    })
  })

  it('passes a PlanModesInput through untouched', () => {
    const input = { direct: ['WALK'], directOnly: true }
    expect(toPlanModesInput(input)).toBe(input)
  })

  it('falls back to WALK for a mode no planConnection enum takes', () => {
    // A bare SCOOTER is not a PlanDirectMode (only SCOOTER_RENTAL is).
    expect(toPlanModesInput([{ mode: 'SCOOTER' }])).toEqual({
      direct: ['WALK'],
      directOnly: true
    })
  })

  it('collapses the three-mode flex bundling onto one enum value', () => {
    // The legacy flex bundling names FLEX three times (one per qualifier);
    // every one maps to the same planConnection enum, and a repeated value
    // is a server-side error — measured live: "Only one or two modes can be
    // specified for a leg, got: [FLEXIBLE, FLEXIBLE, FLEXIBLE]".
    const input = toPlanModesInput([
      { mode: 'TRANSIT' },
      { mode: 'FLEX', qualifier: 'ACCESS' },
      { mode: 'FLEX', qualifier: 'EGRESS' },
      { mode: 'FLEX', qualifier: 'DIRECT' }
    ])
    expect(input).toEqual({
      transit: { access: ['FLEX'], egress: ['FLEX'], transfer: [] },
      transitOnly: true
    })
  })

  it('collapses duplicate direct modes', () => {
    expect(
      toPlanModesInput([
        { mode: 'FLEX', qualifier: 'ACCESS' },
        { mode: 'FLEX', qualifier: 'EGRESS' }
      ])
    ).toEqual({ direct: ['FLEX'], directOnly: true })
  })
})

describe('util > plan-combinations > generateModeSubsets', () => {
  it('fans transit + bicycle out into the valid subsets', () => {
    const combos = generateModeSubsets({
      modeSettings: [],
      modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }]
    })
    const modeSets = combos
      .map((c) => c.modes.map((m) => m.mode).sort().join('+'))
      .sort()
    expect(modeSets).toEqual(['BICYCLE', 'BICYCLE+TRANSIT', 'TRANSIT'])
  })

  it('enumerates the flex subsets; apiV2 applies the 0-or-3 flex filter', () => {
    // generateModeSubsets is the pure subset enumeration core-utils 16.1.0
    // provided; the "all 3 flex modes or none" bundling filter is applied in
    // routingQuery (apiV2), over these subsets.
    const combos = generateModeSubsets({
      modeSettings: [],
      modes: [{ mode: 'TRANSIT' }, { mode: 'FLEX' }]
    })
    const modeSets = combos
      .map((c) => c.modes.map((m) => m.mode).sort().join('+'))
      .sort()
    expect(modeSets).toEqual(['FLEX+TRANSIT', 'TRANSIT'])
  })
})