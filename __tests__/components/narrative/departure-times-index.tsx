/* eslint-disable @typescript-eslint/no-explicit-any */
import '../../test-utils/mock-window-matchMedia'
import '../../test-utils/mock-window-url'
import { createIntl } from 'react-intl'
import { readFileSync } from 'fs'
import path from 'path'

import qs from 'qs'
import yaml from 'js-yaml'

import {
  collectItinerariesWithoutDuplicates,
  findItineraryIndexByKey,
  itineraryIdentityKey
} from '../../../lib/util/itinerary'
import {
  doMergeItineraries,
  resolveUrlItineraryIndex
} from '../../../lib/components/narrative/narrative-itineraries'
import { MetroItinerary } from '../../../lib/components/narrative/metro/metro-itinerary'
import { mockWithProvider } from '../../test-utils/mock-data/store'
import { setActiveItinerary } from '../../../lib/actions/narrative'
import DepartureTimesList, {
  LATE_DEPARTURE_CONFIRM_MINUTES,
  minutesAfterRowDeparture,
  rowDepartureTime
} from '../../../lib/components/narrative/metro/departure-times-list'
import responses from '../../test-utils/mock-data/0921-0912-search-responses.json'
import started from '../../test-utils/mock-data/0921-0902-started-itineraries.json'

/**
 * Backlog 23.1 and 23.5 — 2026-09-21, session mubbbiy9-6zjoq9.
 *
 * 09:00:51.406  START_GO_MODE  bike 09:07 > Orange 09:14:41  (trip 1:1268952)
 * 09:01:55.445  STOP_GO_MODE
 * 09:02:04.095  SET_ACTIVE_ITINERARY  <a whole itinerary object>
 * 09:02:05.246  START_GO_MODE  bike 10:04 > Orange 10:12:00  (trip 1:1348464)
 * 09:12:57       note 2: "Look at the times!!"  (sheet: 61 min wait)
 *
 * Cycle 1 established WHERE the 30 -> 38 jump came from (results-index-
 * mapping.ts): both itineraries are in ONE merged row, and the row renders
 * every folded departure as its own inline-text button — eight of them,
 * 09:07 to 10:04, inside a single card. This file is the fix:
 *
 *  - 23.1  starting a departure more than LATE_DEPARTURE_CONFIRM_MINUTES
 *          after the row's own time asks first (the rider's answer A,
 *          2026-09-21 16:30). 23.1 also made every departure a 44 px chip;
 *          21.5 (2026-09-23) put them back in the small inline sentence at
 *          the rider's request, and the confirm stays.
 *  - 23.5  the URL stops naming the chosen trip by its POSITION in the list.
 *
 * The suite runs in America/Los_Angeles (global-setup.js), so the Minneapolis
 * 09:07 / 10:04 read as 7:07 AM / 8:04 AM in the copy asserted below.
 */

/** Jest maps i18n/*.yml to an empty object; read the shipped English file. */
function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.safeLoad(
    readFileSync(path.join(__dirname, '../../../i18n/en-US.yml'), 'utf8')
  )
)
const intl = createIntl({ locale: 'en-US', messages })

// config.itinerary.mergeByRouteSignature, app-config.yml:483
const MERGE_BY_ROUTE_SIGNATURE = true
const DEFAULT_FARE_TYPE = { mediumId: null, riderCategoryId: null } as any

const itin30 = (started as any)['30'].itinerary
const itin38 = (started as any)['38'].itinerary

/** The 09:02 card: the two departures the rider actually started, merged. */
function riddenRow(): any {
  const { mergedItineraries } = doMergeItineraries(
    [itin30, itin38],
    DEFAULT_FARE_TYPE,
    MERGE_BY_ROUTE_SIGNATURE
  )
  return mergedItineraries[0]
}

/** The list the 09:12:07 re-plan produced, in store order. */
function replannedList(): any[] {
  const response = [0, 1, 2].map((i) => ({
    plan: { itineraries: (responses as any)[String(i)].itineraries }
  }))
  return collectItinerariesWithoutDuplicates(response as any) as any[]
}

function render(itinerary: any, setActiveItinerary = jest.fn()) {
  const { wrapper } = mockWithProvider(
    DepartureTimesList,
    { itinerary, setActiveItinerary },
    undefined,
    messages
  )
  return { setActiveItinerary, wrapper }
}

const times = (wrapper: any) => wrapper.find('button.timeInfo')

describe('21.5 > the departures are the small sentence again', () => {
  // 23.1 turned them into 44 px chips on 2026-09-21; on 2026-09-23 the rider
  // asked for the smaller display back: "there are still times being shown
  // with big buttons (i liked the display when it was smaller)".
  it('lists every folded departure inline, joined with "or"', () => {
    const { wrapper } = render(riddenRow())
    expect(times(wrapper)).toHaveLength(2)
    // The "(Based on ... data)" parts are the screen-reader-only labels.
    expect(wrapper.text()).toMatch(/^7:07 AM \([^)]*\) or 8:04 AM \([^)]*\)$/)
  })

  it('draws no chips and no chip strip', () => {
    const { wrapper } = render(riddenRow())
    expect(wrapper.find('.departure-chip')).toHaveLength(0)
    expect(wrapper.find('.departure-chips')).toHaveLength(0)
    const css = readFileSync(
      path.join(
        __dirname,
        '../../../lib/components/narrative/default/itinerary.css'
      ),
      'utf8'
    )
    expect(css).not.toContain('departure-chip')
  })

  it('marks the departure the card is on', () => {
    const { wrapper } = render(riddenRow())
    expect(times(wrapper).at(0).prop('className')).toContain('active')
    expect(times(wrapper).at(1).prop('className')).not.toContain('active')
  })

  it('selects the tapped departure, not the row', () => {
    const { setActiveItinerary, wrapper } = render(riddenRow())
    times(wrapper).at(1).simulate('click')
    expect(setActiveItinerary).toHaveBeenCalledTimes(1)
    expect(setActiveItinerary.mock.calls[0][0].index).toBe(38)
  })

  it('leaves a one-departure row as the plain time it was', () => {
    const { wrapper } = render(itin30)
    expect(times(wrapper)).toHaveLength(1)
    expect(wrapper.text()).not.toContain(' or ')
  })
})

describe('backlog 23.1 > starting a much later departure asks first', () => {
  const realConfirm = window.confirm
  afterEach(() => {
    window.confirm = realConfirm
  })

  /** The card as rendered when a tap has made a later departure active. */
  function cardFor(itinerary: any, props: any = {}) {
    const beginGoMode = jest.fn()
    const card: any = new (MetroItinerary as any)({
      beginGoMode,
      intl,
      itinerary,
      ...props
    })
    return { beginGoMode, card }
  }

  /** The row, with `itinerary` swapped for the departure the rider chose. */
  function expandedOn(index: number): any {
    const row = riddenRow()
    const chosen = row.allStartTimes.find(
      (time: any) => time.itinerary.index === index
    ).itinerary
    // narrative-itineraries hangs the row's allStartTimes on every itinerary
    // in it (:180-188) and renders `itineraries[activeItinerary]` when
    // expanded, which is what index 38's START_GO_MODE payload carried.
    return { ...chosen, allStartTimes: row.allStartTimes }
  }

  it('measures 57 minutes between the row and the trip that started', () => {
    expect(rowDepartureTime(riddenRow())).toBe(+itin30.startTime)
    expect(minutesAfterRowDeparture(expandedOn(38))).toBe(57)
    expect(minutesAfterRowDeparture(expandedOn(30))).toBe(0)
  })

  it('asks before starting it, naming the two times and nothing else', () => {
    const confirm = jest.fn(() => true)
    window.confirm = confirm as any
    const { beginGoMode, card } = cardFor(expandedOn(38))
    card._handleStartTrip()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0][0]).toBe('Start 8:04 AM instead of 7:07 AM?')
    expect(beginGoMode).toHaveBeenCalledTimes(1)
  })

  it('does not start it when the rider says no', () => {
    window.confirm = jest.fn(() => false) as any
    const { beginGoMode, card } = cardFor(expandedOn(38))
    card._handleStartTrip()
    // FAILS BEFORE: beginGoMode ran on the first tap, 1.15 s after the chip.
    expect(beginGoMode).not.toHaveBeenCalled()
  })

  it('never asks about the departure the row itself advertises', () => {
    const confirm = jest.fn(() => true)
    window.confirm = confirm as any
    const { beginGoMode, card } = cardFor(expandedOn(30))
    card._handleStartTrip()
    expect(confirm).not.toHaveBeenCalled()
    expect(beginGoMode).toHaveBeenCalledTimes(1)
  })

  it('never asks about a one-departure row', () => {
    const confirm = jest.fn(() => true)
    window.confirm = confirm as any
    const { beginGoMode, card } = cardFor(itin38)
    card._handleStartTrip()
    expect(confirm).not.toHaveBeenCalled()
    expect(beginGoMode).toHaveBeenCalledTimes(1)
  })

  it('leaves the next bus alone: 20 minutes is not an hour', () => {
    // The threshold is the rider's; a departure inside it is the ordinary
    // "take the one after" and must not grow a dialog.
    const row = riddenRow()
    const soon = {
      ...itin38,
      legs: itin38.legs.map((leg: any, i: number) => ({
        ...leg,
        startTime:
          +itin30.legs[i].startTime + LATE_DEPARTURE_CONFIRM_MINUTES * 60000
      })),
      startTime: +itin30.startTime + LATE_DEPARTURE_CONFIRM_MINUTES * 60000
    }
    const confirm = jest.fn(() => true)
    window.confirm = confirm as any
    const { beginGoMode, card } = cardFor({
      ...soon,
      allStartTimes: row.allStartTimes
    })
    card._handleStartTrip()
    expect(
      minutesAfterRowDeparture({
        ...soon,
        allStartTimes: row.allStartTimes
      } as any)
    ).toBe(LATE_DEPARTURE_CONFIRM_MINUTES)
    expect(confirm).not.toHaveBeenCalled()
    expect(beginGoMode).toHaveBeenCalledTimes(1)
  })

  it('still confirms a switch away from a running trip, as before', () => {
    const confirm = jest.fn(() => true)
    window.confirm = confirm as any
    const { beginGoMode, card } = cardFor(expandedOn(38), {
      returnToGoMode: jest.fn(),
      tripActive: true
    })
    card._handleStartTrip()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(confirm.mock.calls[0][0]).toContain('instead of')
    expect(confirm.mock.calls[1][0]).toContain('Switch your active trip')
    expect(beginGoMode).toHaveBeenCalledTimes(1)
  })
})

describe('backlog 23.5 > the chosen trip survives a re-plan', () => {
  const chosenKey = itineraryIdentityKey(itin38)

  it('measures the renumbering: index 38 is a different bus afterwards', () => {
    const list = replannedList()
    const tripsOf = (itin: any) =>
      itin.legs.filter((l: any) => l.transitLeg).map((l: any) => l.trip.gtfsId)
    // What the rider chose at 09:02:04 ...
    expect(tripsOf(itin38)).toEqual(['1:1348464'])
    // ... and what position 38 had become by the 09:12:07 re-plan.
    expect(tripsOf(list[38])).toEqual(['1:1348091', '1:1131613'])
  })

  it('finds the rider’s own trip at its new position', () => {
    const list = replannedList()
    const found = findItineraryIndexByKey(list, chosenKey)
    // 1:1348464 again — the trip they picked, two rows up from where the URL
    // was pointing, and two minutes later than when they picked it.
    expect(found).toBe(36)
    expect(
      list[found].legs
        .filter((l: any) => l.transitLeg)
        .map((l: any) => l.trip.gtfsId)
    ).toEqual(['1:1348464'])
    // 124 s later than the copy the rider chose — which is why the start time
    // breaks ties in the key and is not part of the identity.
    expect(+list[found].startTime - +itin38.startTime).toBe(124000)
  })

  it('does not settle for a trip that merely rides the same route', () => {
    // 11 and 35 ride 1:1348464 too, but continue on 1:888286 afterwards: a
    // different journey, and not what the rider chose.
    const list = replannedList()
    expect(itineraryIdentityKey(list[11])).not.toBe(chosenKey)
    expect(itineraryIdentityKey(list[35])).not.toBe(chosenKey)
    expect(findItineraryIndexByKey(list, itineraryIdentityKey(list[11]))).toBe(
      11
    )
  })

  it('names a street-only itinerary by its mode, not by an empty string', () => {
    const list = replannedList()
    // Response 1 is the whole-way bike: no trip to name.
    expect(itineraryIdentityKey(list[27])).toMatch(/^bicycle@\d+$/)
    expect(findItineraryIndexByKey(list, itineraryIdentityKey(list[27]))).toBe(
      27
    )
  })

  it('has no key for an itinerary that has no legs', () => {
    expect(itineraryIdentityKey(undefined)).toBe('')
    expect(itineraryIdentityKey({ legs: [] } as any)).toBe('')
    expect(findItineraryIndexByKey(replannedList(), '')).toBe(-1)
  })

  it('keeps the variant the rider chose when two share a key', () => {
    // Same trips, same minute, different closing bike ride: the merge keeps
    // both and 16.6's drill-down exists to choose between them, so the key
    // alone cannot tell them apart. Without the preference the second variant
    // would be silently swapped for the first on the next render.
    const list = replannedList()
    const twin = {
      ...list[36],
      legs: list[36].legs.map((l: any) => ({ ...l }))
    }
    const pair = [...list, twin]
    expect(itineraryIdentityKey(twin)).toBe(itineraryIdentityKey(list[36]))
    expect(findItineraryIndexByKey(pair, chosenKey, pair.length - 1)).toBe(
      pair.length - 1
    )
    expect(findItineraryIndexByKey(pair, chosenKey, 36)).toBe(36)
    // No preference given: the first match still wins, as before.
    expect(findItineraryIndexByKey(pair, chosenKey)).toBe(36)
  })
})

describe('backlog 23.5 > what the URL is allowed to select', () => {
  const list = replannedList()
  const chosenKey = itineraryIdentityKey(itin38)

  it('selects the trip the key names, not the index the URL carries', () => {
    // FAILS BEFORE: the restore took +uiActiveItinerary, i.e. 38, which was
    // 1:1348091 at 10:19 — restored four times on 2026-09-21 (09:12:36.764,
    // 09:20:55.661, 09:22:27.887, 09:23:46.089).
    expect(
      resolveUrlItineraryIndex({
        itineraries: list,
        key: chosenKey,
        pending: false,
        urlIndex: 38
      })
    ).toBe(36)
  })

  it('clears the selection once the trip is gone from a settled search', () => {
    expect(
      resolveUrlItineraryIndex({
        itineraries: list,
        key: '1:notatrip@29816404',
        pending: false,
        urlIndex: 38
      })
    ).toBe(-1)
  })

  it('waits instead of clearing while the responses are still arriving', () => {
    // Three mode combinations come back separately; an unmatched key mid-flight
    // means "not here yet", and clearing then would drop the rider's choice
    // for no reason.
    expect(
      resolveUrlItineraryIndex({
        itineraries: list,
        key: '1:notatrip@29816404',
        pending: true,
        urlIndex: 38
      })
    ).toBe(null)
    expect(
      resolveUrlItineraryIndex({
        itineraries: [],
        key: chosenKey,
        pending: false,
        urlIndex: 38
      })
    ).toBe(null)
  })

  it('still honours a URL written before the key existed', () => {
    expect(
      resolveUrlItineraryIndex({
        itineraries: list,
        key: undefined,
        pending: false,
        urlIndex: 38
      })
    ).toBe(38)
    expect(
      resolveUrlItineraryIndex({
        itineraries: list,
        key: undefined,
        pending: false,
        urlIndex: NaN
      })
    ).toBe(null)
  })
})

describe('backlog 23.5 > the URL carries the trips, not just the position', () => {
  /** connected-react-router's `push` lands as one of these. */
  const ROUTER = '@@router/CALL_HISTORY_METHOD'

  function run(payload: any, otp: any = {}) {
    const actions: any[] = []
    const getState = () => ({ otp, router: { location: { pathname: '/' } } })
    const dispatch: any = (action: any) => {
      if (typeof action === 'function') return action(dispatch, getState)
      actions.push(action)
      return action
    }
    setActiveItinerary(payload)(dispatch, getState)
    const push = actions.find((a: any) => a.type === ROUTER)
    return {
      actions,
      query: qs.parse(String(push?.payload?.args?.[0]).split('?')[1] || '')
    }
  }

  beforeEach(() => {
    window.history.replaceState(
      {},
      '',
      '/?ui_activeSearch=mmzc6wkfw&ui_activeItinerary=30'
    )
  })

  it('names the trip the rider tapped, alongside its position', () => {
    const { query } = run(itin38)
    expect(query.ui_activeItinerary).toBe('38')
    expect(query.ui_activeItineraryKey).toBe(itineraryIdentityKey(itin38))
    expect(query.ui_activeItineraryKey).toMatch(/^1:1348464@/)
  })

  it('resolves a bare {index} against the list on screen', () => {
    // The restore and the back button pass an index; without this the key in
    // the URL would keep pointing at whatever was chosen before them.
    const list = replannedList()
    const { query } = run(
      { index: 36 },
      {
        activeSearchId: 'a',
        config: {},
        searches: { a: { response: [{ plan: { itineraries: list } }] } }
      }
    )
    expect(query.ui_activeItinerary).toBe('36')
    expect(query.ui_activeItineraryKey).toBe(itineraryIdentityKey(list[36]))
  })

  it('keeps a key the caller already knows (the back button)', () => {
    // handleBackButtonPress restores the index out of the history entry; the
    // key rides along so the entry keeps naming the trip chosen there.
    const { query } = run({ index: 38, key: '1:1348464@29816404' })
    expect(query.ui_activeItineraryKey).toBe('1:1348464@29816404')
  })

  it('takes both out of the URL when the selection is cleared', () => {
    const { query } = run({ index: -1 })
    expect(query.ui_activeItinerary).toBeUndefined()
    expect(query.ui_activeItineraryKey).toBeUndefined()
    expect(query.ui_itineraryView).toBeUndefined()
  })
})
