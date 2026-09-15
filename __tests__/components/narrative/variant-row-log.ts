import { summariseVariantRows } from '../../../lib/components/narrative/narrative-itineraries'

/**
 * Backlog 16.6: whether the variants control was on screen during the
 * 2026-09-15 ride could not be established, because the only record of the
 * results list was ROUTING_RESPONSE and all twelve of those were logged as
 * `__summary: true`. This is the small payload that answers it next time.
 */

const BASE = 1_789_484_400_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const itin = (index: number, stop: string, offsetMin = 0): any => ({
  endTime: BASE + (offsetMin + 40) * 60000,
  index,
  legs: [
    {
      from: { name: 'Home', vertexType: 'NORMAL' },
      mode: 'BICYCLE',
      to: { name: stop, vertexType: 'TRANSIT' }
    },
    {
      from: { name: stop, vertexType: 'TRANSIT' },
      mode: 'BUS',
      to: { name: 'Burnsville', vertexType: 'TRANSIT' },
      transitLeg: true
    }
  ],
  startTime: BASE + offsetMin * 60000
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = (variants: any[]): any =>
  Object.assign({}, variants[0], { sameShapeVariants: variants })

describe('components > narrative > variant row debug summary', () => {
  it('reports no control on a list of plain rows', () => {
    expect(
      summariseVariantRows([
        itin(0, 'Lake St / Midtown'),
        itin(1, '46th St Station')
      ])
    ).toEqual({
      rows: 2,
      rowsWithStopChoice: 0,
      rowsWithVariants: 0,
      variantCounts: [0, 0]
    })
  })

  it('counts the rows that carried a control, and how many folded into each', () => {
    const summary = summariseVariantRows([
      row([
        itin(0, 'Lake St / Midtown'),
        itin(1, 'Lake St / Midtown', 12),
        itin(2, 'Lake St / Midtown', 24)
      ]),
      itin(3, 'Nicollet Mall'),
      row([itin(4, '46th St Station'), itin(5, '38th St Station', 9)])
    ])
    expect(summary.rows).toBe(3)
    expect(summary.rowsWithVariants).toBe(2)
    expect(summary.variantCounts).toEqual([3, 0, 2])
  })

  it('singles out the rows that offer a choice of BOARDING STOP', () => {
    // The thing the rider was hunting for: same route, somewhere else to get
    // on. A row whose variants all board in the same place is not one.
    const summary = summariseVariantRows([
      row([itin(0, 'Lake St / Midtown'), itin(1, 'Lake St / Midtown', 12)]),
      row([itin(2, '46th St Station'), itin(3, '38th St Station', 9)])
    ])
    expect(summary.rowsWithStopChoice).toBe(1)
  })

  it('survives an empty or missing list', () => {
    expect(summariseVariantRows([]).rows).toBe(0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(summariseVariantRows(undefined as any).rows).toBe(0)
  })

  it('carries no stop names or coordinates off the phone', () => {
    const summary = summariseVariantRows([
      row([itin(0, '46th St Station'), itin(1, '38th St Station', 9)])
    ])
    expect(JSON.stringify(summary)).not.toMatch(/46th|38th|Home/)
  })
})
