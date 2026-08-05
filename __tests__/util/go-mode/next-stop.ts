import { encode } from '@mapbox/polyline'

import {
  countStopsAhead,
  hasDegenerateStopList,
  orderedStopsOnLeg
} from '../../../lib/util/go-mode/next-stop'

// A straight leg with 4 coordinated intermediate stops plus the alight stop.
// 0.005° of latitude between polyline points ≈ 555m.
const line: [number, number][] = []
for (let i = 0; i <= 20; i++) line.push([i * 0.005, 0])
const stopAt = (lat: number, name: string) => ({ lat, lon: 0, name })
const leg: any = {
  intermediateStops: [
    stopAt(0.02, 'Early Stop'),
    stopAt(0.04, 'Mid A'),
    stopAt(0.06, 'Mid B'),
    stopAt(0.08, 'Mid C')
  ],
  legGeometry: { points: encode(line, 5) },
  mode: 'BUS',
  to: { lat: 0.1, lon: 0, name: 'Destination' }
}

describe('countStopsAhead', () => {
  it('refuses a non-finite progress — no position fact, no count', () => {
    // NaN survives the clamp, fails every fraction comparison, and used to
    // land on the last stop: "1 stop remaining" out of thin air.
    expect(countStopsAhead(leg, NaN)).toBeNull()
    expect(countStopsAhead(leg, undefined as any)).toBeNull()
  })

  it('counts all stops at the start of the leg', () => {
    expect(countStopsAhead(leg, 0)).toEqual({
      nextStopName: 'Early Stop',
      stopsRemaining: 5
    })
  })

  it('reports 0 remaining at saturated progress — the rider is AT the stop', () => {
    // Was asserted as 1, latching "1 stop remaining" forever once progress
    // saturated. Progress past the final stop's fraction means the rider is
    // at or past the alight stop, so none are still ahead — the same rule
    // AT_STOP_EPSILON already states for every other stop on the leg.
    // (2026-08-02 Orange Line ride.)
    expect(countStopsAhead(leg, 1)).toEqual({
      nextStopName: 'Destination',
      stopsRemaining: 0
    })
  })

  it('still reports 1 on the genuine final approach', () => {
    // The companion to the case above: not yet at the stop, one to go.
    expect(countStopsAhead(leg, 0.99)).toEqual({
      nextStopName: 'Destination',
      stopsRemaining: 1
    })
  })
})

describe('orderedStopsOnLeg', () => {
  it('falls back to the fuller list when intermediatePlaces drops entries', () => {
    // Some responses carry coordinateless intermediatePlaces; toOrderedStop
    // drops them, which used to collapse the count to just the alight stop.
    const degraded = {
      ...leg,
      intermediatePlaces: [
        { name: 'No Coords A' },
        { name: 'No Coords B' },
        { name: 'No Coords C' },
        { name: 'No Coords D' }
      ]
    }
    const ordered = orderedStopsOnLeg(degraded)
    expect(ordered.map((s) => s.name)).toEqual([
      'Early Stop',
      'Mid A',
      'Mid B',
      'Mid C',
      'Destination'
    ])
  })

  it('still prefers intermediatePlaces when it is at least as complete', () => {
    const places = {
      ...leg,
      intermediatePlaces: [
        stopAt(0.02, 'Places A'),
        stopAt(0.04, 'Places B'),
        stopAt(0.06, 'Places C'),
        stopAt(0.08, 'Places D')
      ]
    }
    expect(orderedStopsOnLeg(places)[0].name).toBe('Places A')
  })
})

describe('hasDegenerateStopList', () => {
  it('flags a leg that claims intermediates but whose list collapsed to the alight stop', () => {
    const collapsed = {
      intermediatePlaces: [{ name: 'No Coords A' }, { name: 'No Coords B' }],
      legGeometry: leg.legGeometry,
      mode: 'BUS',
      to: leg.to
    }
    expect(hasDegenerateStopList(collapsed)).toBe(true)
  })

  it('a leg genuinely without intermediates is not degenerate — 1 stop remaining is correct', () => {
    const nonstop = { legGeometry: leg.legGeometry, mode: 'BUS', to: leg.to }
    expect(hasDegenerateStopList(nonstop)).toBe(false)
  })

  it('a healthy stop list is not degenerate', () => {
    expect(hasDegenerateStopList(leg)).toBe(false)
  })
})
