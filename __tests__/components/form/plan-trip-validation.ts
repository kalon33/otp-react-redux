import { alertUserTripPlan } from '../../../lib/components/form/util'

/**
 * `alertUserTripPlan(intl, query, onPlanTripClick, routingQuery)`: validation
 * runs BEFORE the search, and an invalid query alerts instead of searching.
 * The mobile Plan-trip button passed the last two arguments swapped (backlog
 * 10.3), so on the phone the search fired ahead of validation and the alert
 * could never show. Pinned here through the declared order; the mobile call
 * site is now in that order.
 */
describe('lib > components > form > util > alertUserTripPlan', () => {
  const intl: any = {
    formatList: (items: string[]) => items.join(' and '),
    formatMessage: ({ id }: { id: string }) => id
  }
  const validQuery = {
    from: { lat: 44.9, lon: -93.2, name: 'A' },
    to: { lat: 44.95, lon: -93.25, name: 'B' }
  }

  beforeEach(() => {
    window.alert = jest.fn()
  })

  it('marks the click, then searches, when the query is valid', () => {
    const calls: string[] = []
    alertUserTripPlan(
      intl,
      validQuery,
      () => calls.push('click'),
      () => {
        calls.push('search')
        return undefined as any
      }
    )
    expect(calls).toEqual(['click', 'search'])
    expect(window.alert).not.toHaveBeenCalled()
  })

  it('alerts and does NOT search when a location is missing', () => {
    const routingQuery = jest.fn()
    const onPlanTripClick = jest.fn()
    alertUserTripPlan(
      intl,
      { from: validQuery.from, to: null },
      onPlanTripClick,
      routingQuery
    )
    expect(onPlanTripClick).toHaveBeenCalledTimes(1)
    expect(routingQuery).not.toHaveBeenCalled()
    expect(window.alert).toHaveBeenCalledTimes(1)
  })
})
