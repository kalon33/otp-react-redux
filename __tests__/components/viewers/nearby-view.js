import nock from 'nock'
import '../../test-utils/mock-window-url'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import NearbyView from '../../../lib/components/viewers/nearby/nearby-view'

import nearbyScootersInvalidDates from './nearby-mocks/nearby-scooters-invalid-dates.json'

describe('components > viewers > nearby view', () => {
  afterEach(() => {
    nock.cleanAll()
  })

  it('renders nothing on a blank page', () => {
    nock('https://example.com')
      .persist()
      .get(/.*/)
      .reply(200, {})
      .post(/.*/)
      .reply(200, {})
    const mockState = getMockInitialState()
    mockState.otp.config.api = { host: 'https://example.com', path: '/otp/routers/default' }
    mockState.otp.transitIndex.nearby = {
      data: []
    }
    mockState.router.location = { query: {} }
    expect(
      mockWithProvider(NearbyView, {}, mockState).snapshot()
    ).toMatchSnapshot()
  })

  it('renders proper scooter dates', () => {
    nock('https://example.com')
      .persist()
      .get(/.*/)
      .reply(200, {})
      .post(/.*/)
      .reply(200, {})
    const mockState = getMockInitialState()
    mockState.otp.config.api = { host: 'https://example.com', path: '/otp/routers/default' }
    mockState.otp.transitIndex.nearby = {
      data: nearbyScootersInvalidDates
    }
    mockState.router.location = { query: {} }
    expect(
      mockWithProvider(NearbyView, {}, mockState).snapshot()
    ).toMatchSnapshot()
  })
})
