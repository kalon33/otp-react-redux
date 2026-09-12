import nock from 'nock'
import '../../test-utils/mock-window-url'
import {
  getMockInitialState,
  mockWithProvider
} from '../../test-utils/mock-data/store'
import { restoreDateNowBehavior, setDefaultTestTime } from '../../test-utils'
import StopScheduleViewer from '../../../lib/components/viewers/stop-schedule-viewer'

describe('components > viewers > stop viewer', () => {
  afterEach(() => {
    nock.cleanAll()
    restoreDateNowBehavior()
  })
  beforeEach(setDefaultTestTime)

  it('should render with initial stop id and no stop times', () => {
    nock('https://example.com')
      .persist()
      .get(/.*/)
      .reply(200, {})
      .post(/.*/)
      .reply(200, {})
    const mockState = getMockInitialState()
    mockState.otp.config.api = { host: 'https://example.com', path: '/otp/routers/default' }
    mockState.otp.ui.viewedStop = {
      stopId: 'TriMet:13170'
    }

    expect(
      mockWithProvider(StopScheduleViewer, {}, mockState).snapshot()
    ).toMatchSnapshot()
  })
})
