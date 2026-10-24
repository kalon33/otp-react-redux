/* globals describe, expect, it */
import { generateOtp2Query } from '@opentripplanner/core-utils/lib/query-gen'
import { extendPlanQueryWithLevers } from '../../lib/util/routing-profiles'

describe('extendPlanQueryWithLevers planConnection', () => {
  it('grafts the levers onto the default planConnection query', () => {
    const { query } = generateOtp2Query(
      {
        arriveBy: false,
        date: '2026-01-01',
        departArrive: 'DEPART',
        from: { lat: 1, lon: 2, name: 'a' },
        modeSettings: [],
        modes: [{ mode: 'WALK' }],
        time: '10:00',
        to: { lat: 3, lon: 4, name: 'b' }
      },
      'America/Chicago'
    )
    const extended = extendPlanQueryWithLevers(query)
    expect(extended).toContain('$bikeSpeed: Speed')
    expect(extended).toContain('$searchWindow: Duration')
    expect(extended).toContain('boardCost: $walkBoardCost')
    expect(extended).toContain('speed: $bikeSpeed')
    expect(extended).toContain('waitReluctance: $waitReluctance')
    expect(extended).toContain('maximumTransfers: $maxTransfers')
    expect(extended).toContain('slack: $minTransferTime')
    expect(extended).toContain('searchWindow: $searchWindow')
  })
  it('adds the fork stop cap only when opted in', () => {
    const { query } = generateOtp2Query(
      {
        arriveBy: false,
        date: '2026-01-01',
        departArrive: 'DEPART',
        from: { lat: 1, lon: 2, name: 'a' },
        modeSettings: [],
        modes: [{ mode: 'WALK' }],
        time: '10:00',
        to: { lat: 3, lon: 4, name: 'b' }
      },
      'America/Chicago'
    )
    const extended = extendPlanQueryWithLevers(query, {
      enableMaxStopCount: true
    })
    expect(extended).toContain('$maxStopCount: Int')
    expect(extended).toContain('maxStopCount: $maxStopCount')
  })
})

describe('extendPlanQueryWithLevers structure', () => {
  it('keeps a parseable query document', async () => {
    const { parse } = await import('graphql')
    const { query } = generateOtp2Query(
      {
        arriveBy: false,
        date: '2026-01-01',
        departArrive: 'DEPART',
        from: { lat: 1, lon: 2, name: 'a' },
        modeSettings: [],
        modes: [{ mode: 'WALK' }],
        time: '10:00',
        to: { lat: 3, lon: 4, name: 'b' }
      },
      'America/Chicago'
    )
    expect(() => parse(extendPlanQueryWithLevers(query))).not.toThrow()
    expect(() =>
      parse(extendPlanQueryWithLevers(query, { enableMaxStopCount: true }))
    ).not.toThrow()
  })
})
