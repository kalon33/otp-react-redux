/* globals describe, expect, it */
import {
  generateModeSubsets,
  toPlanModesInput,
  toPlanModesInputWithTransitFilter,
  toPlanTransitModePreferences
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
  it('never puts a non-transfer mode into transfer, and walks beside FLEX', () => {
    // FLEX is a legal access/egress mode but NOT a PlanTransferMode; OTP
    // also requires a WALK next to it in the same leg's mode list
    // ("For the time being, FLEXIBLE needs to be combined with WALK mode
    // for the same leg.").
    const input = toPlanModesInput([{ mode: 'TRANSIT' }, { mode: 'FLEX' }])
    expect(input).toEqual({
      transit: {
        access: ['FLEX', 'WALK'],
        egress: ['FLEX', 'WALK'],
        // No PlanTransferMode takes FLEX, and an EMPTY list is a server-side
        // error ("Transfer modes must not be empty.") — the slot is omitted.
        transfer: undefined
      },
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

  it('maps a rented bike to BICYCLE_RENTAL + WALK access, no transfer', () => {
    expect(
      toPlanModesInput([
        { mode: 'TRANSIT' },
        { mode: 'BICYCLE', qualifier: 'RENT' }
      ])
    ).toEqual({
      transit: {
        access: ['BICYCLE_RENTAL', 'WALK'],
        egress: ['BICYCLE_RENTAL', 'WALK'],
        transfer: undefined
      },
      transitOnly: true
    })
  })

  it('walks egress out of a car park-and-ride', () => {
    expect(toPlanModesInput([{ mode: 'TRANSIT' }, { mode: 'CAR' }])).toEqual({
      transit: {
        access: ['CAR_PARKING'],
        egress: ['WALK'],
        transfer: undefined
      },
      transitOnly: true
    })
  })

  it('keeps CAR_RENTAL egress with WALK beside it, no transfer', () => {
    // CAR_RENTAL is a valid PlanEgressMode; only the transfer slot is closed,
    // and OTP requires the WALK next to a rental mode.
    expect(
      toPlanModesInput([
        { mode: 'TRANSIT' },
        { mode: 'CAR', qualifier: 'RENT' }
      ])
    ).toEqual({
      transit: {
        access: ['CAR_RENTAL', 'WALK'],
        egress: ['CAR_RENTAL', 'WALK'],
        transfer: undefined
      },
      transitOnly: true
    })
  })

  it('sends a street-only subset as a direct mode', () => {
    expect(toPlanModesInput([{ mode: 'BICYCLE' }])).toEqual({
      direct: ['BICYCLE'],
      directOnly: true
    })
    // FLEX must name WALK beside it in the same leg (StreetModeMapper).
    expect(toPlanModesInput([{ mode: 'FLEX' }])).toEqual({
      direct: ['FLEX', 'WALK'],
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
    // specified for a leg, got: [FLEXIBLE, FLEXIBLE, FLEXIBLE]". WALK rides
    // beside the surviving FLEX (StreetModeMapper).
    const input = toPlanModesInput([
      { mode: 'TRANSIT' },
      { mode: 'FLEX', qualifier: 'ACCESS' },
      { mode: 'FLEX', qualifier: 'EGRESS' },
      { mode: 'FLEX', qualifier: 'DIRECT' }
    ])
    expect(input).toEqual({
      transit: {
        access: ['FLEX', 'WALK'],
        egress: ['FLEX', 'WALK'],
        // No PlanTransferMode takes FLEX, and an EMPTY list is a server-side
        // error ("Transfer modes must not be empty.") — the slot is omitted.
        transfer: undefined
      },
      transitOnly: true
    })
  })

  it('collapses duplicate direct modes', () => {
    expect(
      toPlanModesInput([
        { mode: 'FLEX', qualifier: 'ACCESS' },
        { mode: 'FLEX', qualifier: 'EGRESS' }
      ])
    ).toEqual({ direct: ['FLEX', 'WALK'], directOnly: true })
  })
})

describe('util > plan-combinations > generateModeSubsets', () => {
  it('fans transit + bicycle out into the valid subsets', () => {
    const combos = generateModeSubsets({
      modes: [{ mode: 'TRANSIT' }, { mode: 'BICYCLE' }],
      modeSettings: []
    })
    const modeSets = combos
      .map((c) =>
        c.modes
          .map((m) => m.mode)
          .sort()
          .join('+')
      )
      .sort()
    expect(modeSets).toEqual(['BICYCLE', 'BICYCLE+TRANSIT', 'TRANSIT'])
  })

  it('enumerates the flex subsets; apiV2 applies the 0-or-3 flex filter', () => {
    // generateModeSubsets is the pure subset enumeration core-utils 16.1.0
    // provided; the "all 3 flex modes or none" bundling filter is applied in
    // routingQuery (apiV2), over these subsets.
    const combos = generateModeSubsets({
      modes: [{ mode: 'TRANSIT' }, { mode: 'FLEX' }],
      modeSettings: []
    })
    const modeSets = combos
      .map((c) =>
        c.modes
          .map((m) => m.mode)
          .sort()
          .join('+')
      )
      .sort()
    expect(modeSets).toEqual(['FLEX+TRANSIT', 'TRANSIT'])
  })
})
describe('util > plan-combinations > wire shape', () => {
  it('omits an empty transfer list from the wire JSON', () => {
    // The server rejects a mode list that is present but empty ("Transfer
    // modes must not be empty."); an omitted slot keeps the server default.
    // JSON.stringify drops undefined, so the FLEX transit block rides as
    // access + egress with no transfer key at all.
    const flex = toPlanModesInput([{ mode: 'TRANSIT' }, { mode: 'FLEX' }])
    expect(JSON.stringify(flex)).not.toContain('"transfer"')
    expect(JSON.parse(JSON.stringify(flex))).toEqual({
      transit: { access: ['FLEX', 'WALK'], egress: ['FLEX', 'WALK'] },
      transitOnly: true
    })
  })
})
/**
 * Rider report (2026-11-02, Paris): the Bus/Tram/Metro toggles did nothing —
 * a deselected bus still came back in the results. core-utils'
 * generateCombinations used to inject the enabled transit submodes as
 * planConnection's modes.transit.transit preference list; the fork's subset
 * fan-out had lost that, so every transit plan went out with no restriction
 * and the server answered with every mode.
 */
describe('util > plan-combinations > transit-mode preferences', () => {
  // The settings the panel builds from config.modes.transitModes (the Paris
  // deployment's five toggles, bus carrying both BUS and TROLLEYBUS).
  const parisSettings = [
    {
      addTransportMode: [{ mode: 'TROLLEYBUS' }, { mode: 'BUS' }],
      applicableMode: 'TRANSIT',
      key: 'bus',
      type: 'SUBMODE',
      value: true
    },
    {
      addTransportMode: { mode: 'TRAM' },
      applicableMode: 'TRANSIT',
      key: 'tram',
      type: 'SUBMODE',
      value: true
    },
    {
      addTransportMode: { mode: 'SUBWAY' },
      applicableMode: 'TRANSIT',
      key: 'metro',
      type: 'SUBMODE',
      value: true
    },
    {
      applicableMode: 'TRANSIT',
      key: 'wheelchair',
      type: 'CHECKBOX',
      value: false
    }
  ]

  it('sends nothing while every transit toggle is on', () => {
    // No exclusion: the server default (all modes) is what the rider asked
    // for, and an explicit list would also drop modes their config omits.
    expect(toPlanTransitModePreferences(parisSettings)).toBeUndefined()
  })

  it('restricts to the enabled modes once the rider deselects one', () => {
    const busOff = parisSettings.map((s) =>
      s.key === 'bus' ? { ...s, value: false } : s
    )
    expect(toPlanTransitModePreferences(busOff)).toEqual([
      { mode: 'TRAM' },
      { mode: 'SUBWAY' }
    ])
  })

  it('rides the restriction on transit plans and leaves street plans alone', () => {
    const busOff = parisSettings.map((s) =>
      s.key === 'bus' ? { ...s, value: false } : s
    )
    // Generic transit button, no street modes alongside: the restriction is
    // the only transit content, and the block is created when absent.
    expect(
      toPlanModesInputWithTransitFilter([{ mode: 'TRANSIT' }], busOff)
    ).toEqual({
      transit: { transit: [{ mode: 'TRAM' }, { mode: 'SUBWAY' }] },
      transitOnly: true
    })
    // Bike-only plan: nothing to restrict.
    expect(
      toPlanModesInputWithTransitFilter([{ mode: 'BICYCLE' }], busOff)
    ).toEqual({ direct: ['BICYCLE'], directOnly: true })
  })
})
