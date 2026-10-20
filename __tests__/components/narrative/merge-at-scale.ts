/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'crypto'

import {
  doMergeItineraries,
  summariseVariantRows
} from '../../../lib/components/narrative/narrative-itineraries'
import fixture from '../../test-utils/mock-data/1021-columbus-oakdale-185-itineraries.json'

/**
 * Backlog 66.1 — 2026-10-20 08:53-08:59, session mvgplnrw-yvtqga, DEV
 * 2026.1020.2: "why is the app unresponsive?". A Columbus Ave -> Oakdale
 * search folded ~230 itineraries into 28 rows; every dispatch took ~3 s and
 * every route-row timetable fill (36.1) 9-24 s.
 *
 * Both costs were deep clones, of whole itineraries with their legs, run once
 * per element of a list:
 *   - doMergeItineraries cloned the accumulated rows once per input
 *     itinerary (O(n²)), re-run on every fill because a fill appends a
 *     response and so hands the memoized merge a new array;
 *   - NarrativeItineraries.render cloned its mode buckets once per row, and
 *     a row carries every itinerary folded into it, on every render — and the
 *     list re-renders on every dispatch.
 *
 * Fixture: the same search re-run on the dev app against production OTP
 * (2026-10-21 08:53, bikeSpeed 8, 14 responses: 4 plan combinations then 10
 * timetable fills), taken after getActiveItineraries (deduplicated, indexed,
 * sorting costs added), with each leg cut down to the fields the merge and
 * the rows read. 185 itineraries -> 26 rows. The expected values were taken
 * from the merge as it was before 66.1, and the old and new merges were
 * compared object for object, shared references included, on this list and
 * on the uncut one.
 */

const { defaultFareType, expected, itineraries, mergeByRouteSignature, nowMs } =
  fixture as any

/** Serialise an object graph; an object met again is written as a $ref. */
function canonical(root: any): string {
  const seen = new Map<any, string>()
  const walk = (value: any, path: string): any => {
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return { $ref: seen.get(value) }
    seen.set(value, path)
    if (Array.isArray(value)) {
      return value.map((item, i) => walk(item, `${path}[${i}]`))
    }
    const out: any = {}
    Object.keys(value)
      .sort()
      .forEach((key) => {
        out[key] = walk(value[key], `${path}.${key}`)
      })
    return out
  }
  return JSON.stringify(walk(root, '$'))
}

/** What a row is to the rider: who represents it, what folded in, its times. */
function signature({ allItineraries, mergedItineraries }: any) {
  const indexes = (list: any[] | undefined) =>
    (list || []).map((item: any) => item.itinerary?.index ?? item.index)
  return {
    all: allItineraries.map((itin: any) => [
      itin.index,
      indexes(itin.sameShapeVariants),
      indexes(itin.allStartTimes)
    ]),
    rows: mergedItineraries.map((row: any) => [
      row.index,
      indexes(row.sameShapeVariants),
      indexes(row.allStartTimes),
      row.legs.map((leg: any) => Object.keys(leg.alternateRoutes || {}).sort())
    ]),
    variantRows: summariseVariantRows(mergedItineraries)
  }
}

function merge(list: any[]) {
  // A fresh array is a fresh cache key (doMergeItineraries is keyed on it).
  return doMergeItineraries([...list], defaultFareType, mergeByRouteSignature)
}

describe('backlog 66.1 > merging a 185-itinerary search', () => {
  let realNow: () => number
  beforeAll(() => {
    // The merge folds only departures within a day of now.
    realNow = Date.now
    Date.now = () => nowMs
  })
  afterAll(() => {
    Date.now = realNow
  })

  it('folds into the same rows, times and variants as before', () => {
    const result = merge(itineraries)
    expect(result.mergedItineraries).toHaveLength(26)
    expect(signature(result)).toEqual(expected.signature)
  })

  it('is the same object graph as before, shared references included', () => {
    const graph = canonical(merge(itineraries))
    expect(createHash('sha256').update(graph).digest('hex')).toBe(
      expected.canonicalSha256
    )
  })

  it('leaves its input untouched', () => {
    const before = JSON.stringify(itineraries)
    merge(itineraries)
    expect(JSON.stringify(itineraries)).toBe(before)
  })

  it('stays fast as the timetable fills append (was ~44 s a merge in jest)', () => {
    // One merge per arriving fill, as the list re-merges on each. The old
    // merge took 15-70 s per step here; the new one ~0.1-0.2 s. The bound is
    // loose on purpose: it catches the quadratic clone coming back, not noise.
    const start = realNow()
    for (let n = 73; n <= itineraries.length; n += 28) {
      merge(itineraries.slice(0, n))
    }
    expect(realNow() - start).toBeLessThan(10000)
  })
})
