/**
 * The stop lookup behind the settings panel's "must pass through this stop"
 * field (backlog 4.9). Mocks the GraphQL helper so the assertions are about
 * what the field is handed, not about the network.
 */
jest.mock('../../lib/actions/apiV2', () => ({
  createGraphQLQueryAction: (
    query: string,
    variables: any,
    responseAction: any,
    errorAction: any
  ) => {
    const answer = (global as any).__stopsAnswer
    return answer instanceof Error
      ? errorAction(answer)
      : responseAction({ data: { stops: answer } })
  }
}))

// eslint-disable-next-line import/first
import { lookupViaStops } from '../../lib/actions/routing-profiles'

const g = global as any

// A dispatch that runs thunks and calls plain functions, which is what the
// resolve-shaped callbacks above return.
const dispatch: any = (action: any) =>
  typeof action === 'function' ? action(dispatch) : action

describe('lookupViaStops', () => {
  afterEach(() => {
    g.__stopsAnswer = undefined
  })

  it('groups the platforms of one station under a single suggestion', async () => {
    // Lake & Chicago Station is two stops, one per direction. The rider is
    // naming a place; pinning one platform would forbid the other direction.
    g.__stopsAnswer = [
      { gtfsId: '1:16871', name: 'Lake & Chicago Station' },
      { gtfsId: '1:56796', name: 'Lake & Chicago Station' }
    ]
    const found = await lookupViaStops('Lake & Chicago')(dispatch)
    expect(found).toEqual([
      { ids: ['1:16871', '1:56796'], name: 'Lake & Chicago Station' }
    ])
  })

  it('keeps genuinely different stops apart', async () => {
    g.__stopsAnswer = [
      { gtfsId: '1:50', name: 'Chicago Ave S & 31st St E' },
      { gtfsId: '1:801', name: 'Chicago Ave S & 31st St E' },
      { gtfsId: '1:56913', name: 'Chicago & Lake Station' }
    ]
    const found = await lookupViaStops('chicago')(dispatch)
    expect(found.map((s) => s.name)).toEqual([
      'Chicago Ave S & 31st St E',
      'Chicago & Lake Station'
    ])
  })

  it('does not ask the server about one or two characters', async () => {
    g.__stopsAnswer = new Error('should not be called')
    expect(await lookupViaStops('la')(dispatch)).toEqual([])
    expect(await lookupViaStops('   ')(dispatch)).toEqual([])
  })

  it('answers with an empty list when the server errors', async () => {
    g.__stopsAnswer = new Error('boom')
    expect(await lookupViaStops('Lake & Chicago')(dispatch)).toEqual([])
  })
})
