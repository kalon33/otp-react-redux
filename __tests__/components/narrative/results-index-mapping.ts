/* eslint-disable @typescript-eslint/no-explicit-any */
import { addTrueIndex } from '../../../lib/components/map/itinerary-summary-overlay'
import {
  collectItinerariesWithoutDuplicates,
  itineraryAccessModeId,
  transitRouteSignature
} from '../../../lib/util/itinerary'
import { doMergeItineraries } from '../../../lib/components/narrative/narrative-itineraries'
import responses from '../../test-utils/mock-data/0921-0912-search-responses.json'

/**
 * Backlog 23.1 — 2026-09-21 09:02:04, session mubbbiy9-6zjoq9.
 *
 *   09:02:04.023  SET_VISIBLE_ITINERARY {index: null}
 *   09:02:04.023  SET_VISIBLE_ITINERARY {index: 30}
 *   09:02:04.095  SET_ACTIVE_ITINERARY  <a whole itinerary object>
 *   09:02:04.199  @@router/LOCATION_CHANGE ... &ui_activeItinerary=38
 *   09:02:05.246  START_GO_MODE  bike 10:04:26 > Orange 10:12:00 (trip 1:1348464)
 *
 * The rider had started index 30 seventy-three seconds earlier
 * (09:00:51.406 START_GO_MODE, bike 09:07:07 > Orange 09:14:41, trip
 * 1:1268952). Both itineraries ride 1:904 from I-35W & Lake St to I-35W &
 * 98th St with a 1491 m bike in and a 3970 m bike out — identical shape,
 * 58 minutes apart.
 *
 * The row's hypothesis was that the map's itinerary labels re-derive the
 * index. They do not (see the last test), and the overlay was not on screen
 * at all: mapStateToProps bails unless `config.itinerary.previewOverlay` is
 * true (itinerary-summary-overlay.tsx:225-228) and app-config.yml:497 sets it
 * false. Nor could the 09:02:04.095 dispatch have come from there — the
 * overlay dispatches `{index}` (:198-200) and that action carried a whole
 * itinerary object (keys: legs, index, rank, ... 11297 chars).
 *
 * What produces 30 -> 38 is that both itineraries live in the SAME merged
 * row, and the row renders every folded departure as its own button.
 *
 * The fixture is the 09:12:07 re-run of the same query (the 09:00:25
 * responses were logged as `__summary`), trimmed of the four keys
 * `hashItinerary` already excludes (alerts, intermediateStops, legGeometry,
 * steps) so dedupe and merging are bit-for-bit what the app did.
 */

const DEFAULT_FARE_TYPE = { mediumId: null, riderCategoryId: null } as any
// config.itinerary.mergeByRouteSignature, app-config.yml:483
const MERGE_BY_ROUTE_SIGNATURE = true

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    timeZone: 'America/Chicago'
  })

/**
 * The store's `searches[id].response` is an array indexed by REQUEST index —
 * create-otp-reducer.js:541-561 parks each mode-combination response at
 * `response[action.payload.index]`, so arrival order (1, then 0, then 2 on
 * this search) does not affect it.
 */
const storeResponse = () =>
  [0, 1, 2].map((i) => ({
    plan: { itineraries: (responses as any)[String(i)].itineraries }
  }))

const buildList = () =>
  collectItinerariesWithoutDuplicates(storeResponse() as any) as any[]

describe('backlog 23.1 > results list index <-> departure chips', () => {
  it('numbers the combined list by position across the three responses', () => {
    const list = buildList()
    // 27 WALK+TRANSIT + 1 BICYCLE + 17 TRANSIT+BICYCLE; nothing deduped away.
    expect(list).toHaveLength(45)
    expect(list.map((i) => i.index)).toEqual(list.map((_, i) => i))
    // Response 1 (the whole-way bike) is a single itinerary at index 27, so
    // the bike+transit answers occupy 28..44 — which is where 38 lives.
    expect(list[27].legs.every((l: any) => l.mode === 'BICYCLE')).toBe(true)
    expect(itineraryAccessModeId(list[38])).toBe('bicycle')
  })

  it('folds an hour and a half of Orange Line departures into ONE row', () => {
    const { mergedItineraries } = doMergeItineraries(
      buildList(),
      DEFAULT_FARE_TYPE,
      MERGE_BY_ROUTE_SIGNATURE
    )

    const table = mergedItineraries.map((row: any) => ({
      accessMode: itineraryAccessModeId(row),
      // What DepartureTimesList renders: one button per allStartTimes entry,
      // labelled getFirstLegStartTime(entry.legs), dispatching that entry's
      // own itinerary (departure-times-list.tsx:49-57).
      chips: (row.allStartTimes || [{ itinerary: row, legs: row.legs }]).map(
        (st: any) => `${st.itinerary.index}@${hhmm(+st.legs[0].startTime)}`
      ),
      representative: row.index,
      signature: transitRouteSignature(row)
    }))

    // 16 rows — matches the ITINERARY_VARIANT_ROWS {rows: 16} logged at
    // 09:12:36.713 for this same list.
    expect(table).toHaveLength(16)

    // The bike-access Orange-Line-only row: seven departures, 09:12 to 10:49,
    // every one of them an independent tap target inside one card.
    const orangeByBike = table.find(
      (r: any) => r.signature === '1:904' && r.accessMode === 'bicycle'
    )
    expect(orangeByBike).toEqual({
      accessMode: 'bicycle',
      chips: [
        '29@09:12',
        '32@09:36',
        '34@09:51',
        '36@10:06',
        '39@10:19',
        '40@10:34',
        '43@10:49'
      ],
      representative: 29,
      signature: '1:904'
    })

    // The row the rider's thumb was on is identified by its REPRESENTATIVE
    // index (metro-itinerary.tsx:265-273 dispatches setVisibleItinerary with
    // this.props.index), and the chips inside it carry indices from all over
    // the list — 97 minutes of departures under one hover.
    const span = (r: any) =>
      +r.chips[r.chips.length - 1].split('@')[1].replace(':', '') -
      +r.chips[0].split('@')[1].replace(':', '')
    expect(span(orangeByBike)).toBeGreaterThan(100) // hhmm arithmetic: > 1h
  })

  it('gives the map overlay the SAME index the list uses, not a running count', () => {
    // itinerary-summary-overlay.tsx:161-164 calls addTrueIndex on
    // `activeSearch.response.flatMap(r => r.plan.itineraries)` — raw OTP
    // itineraries, BEFORE doMergeItineraries. None of them carries
    // allStartTimes at that point, so `(prevIndex ?? -1) + (allStartTimes
    // ?.length ?? 1)` is just i. The "cumulative over merged rows" reading of
    // that line is only reachable if the array is already merged, and at the
    // one call site it is not.
    const raw = storeResponse().flatMap((r) => r.plan.itineraries) as any[]
    expect(raw.every((i: any) => i.allStartTimes === undefined)).toBe(true)
    const indexed = addTrueIndex(raw as any)
    expect(indexed.map((i: any) => i.index)).toEqual(raw.map((_, i) => i))
  })
})
