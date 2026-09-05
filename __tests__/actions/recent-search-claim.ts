import {
  claimSearchForRecents,
  resetRememberedSearchIds
} from '../../lib/actions/apiV2'

describe('lib > actions > apiV2 > claimSearchForRecents', () => {
  beforeEach(resetRememberedSearchIds)

  it('lets only the first response of a search plant recents', () => {
    // Three mode combinations, three ROUTING_RESPONSEs, one search id.
    expect(claimSearchForRecents('iic74cx1o')).toBe(true)
    expect(claimSearchForRecents('iic74cx1o')).toBe(false)
    expect(claimSearchForRecents('iic74cx1o')).toBe(false)
  })

  it('does not block the next search', () => {
    expect(claimSearchForRecents('search-1')).toBe(true)
    expect(claimSearchForRecents('search-2')).toBe(true)
    expect(claimSearchForRecents('search-1')).toBe(false)
  })

  it('never blocks when there is no search id', () => {
    expect(claimSearchForRecents(null)).toBe(true)
    expect(claimSearchForRecents(null)).toBe(true)
    expect(claimSearchForRecents(undefined)).toBe(true)
  })

  it('is bounded — an old id falls out rather than growing forever', () => {
    for (let i = 0; i < 21; i++) {
      expect(claimSearchForRecents(`search-${i}`)).toBe(true)
    }
    // search-0 was evicted by the 21st claim; the newest are still held.
    expect(claimSearchForRecents('search-0')).toBe(true)
    expect(claimSearchForRecents('search-20')).toBe(false)
  })
})
