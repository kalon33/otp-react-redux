/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-function, sort-keys */
/**
 * T1 — what does a dispatch that does not touch the search cost on the
 * results screen (RESULTS_SUMMARY, Go Mode off)?
 *
 * Input: a real store snapshot of the 66.1 search (another agent's capture of
 * :9967 `state.otp.searches[activeSearchId]` + config.itinerary + filter +
 * currentQuery) — PERF_CAPTURE, default $PERF_CAPTURES_DIR/capture5.json. Subsets of its
 * responses give the row-count buckets of the field data.
 *
 * Run: scripts/perf/bench.sh results-dispatch.perf.tsx (sets PERF_BENCH=1; the
 * capture is located via PERF_CAPTURES_DIR, see test-utils/perf-utils.ts).
 */
import '../test-utils/mock-window-matchMedia'
import '../test-utils/mock-window-url'
import { applyMiddleware, createStore } from 'redux'
import { ClassicLegIcon, ClassicModeIcon } from '@opentripplanner/icons'
import { IntlProvider } from 'react-intl'
import { mount } from 'enzyme'
import { Provider } from 'react-redux'
import { readFileSync } from 'fs'
import cloneDeep from 'lodash/cloneDeep'

import path from 'path'

import React from 'react'
import thunk from 'redux-thunk'
import yaml from 'js-yaml'

import {
  bench,
  loadJson,
  note,
  PERF_CAPTURES_DIR,
  report
} from '../test-utils/perf-utils'
import { ComponentContext } from '../../lib/util/contexts'
import { demoteTokenTransitHops } from '../../lib/util/itinerary'
import {
  getActiveItineraries,
  getActiveSearchErrors,
  getRealtimeEffects,
  sortItinerariesInPlaceIfNeeded
} from '../../lib/util/state'
import { getItineraryDescription } from '../../lib/components/narrative/default/itinerary-description'
import { getMockInitialState } from '../test-utils/mock-data/store'
import { mapStateToProps as previewMapStateToProps } from '../../lib/components/map/route-preview-overlay'
import { saveGoModeSession } from '../../lib/util/go-mode/session-persistence'
import createOtpReducer from '../../lib/reducers/create-otp-reducer'
import MetroItinerary, {
  MetroItinerary as MetroItineraryClass
} from '../../lib/components/narrative/metro/metro-itinerary'
import NarrativeItineraries, {
  doMergeItineraries
} from '../../lib/components/narrative/narrative-itineraries'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalAny: any = global

// Benchmarks take minutes and need data that CI lacks: skipped unless PERF_BENCH=1
// (scripts/perf/bench.sh sets it). A plain `yarn unit` skips this file.
const RUN = process.env.PERF_BENCH === '1'
const describeBench = RUN ? describe : describe.skip

// Count + time every deep clone the app makes (narrative-itineraries imports
// the `clone` package directly).
const cloneStats = { calls: 0, ms: 0 }
jest.mock('clone', () => {
  const real = jest.requireActual('clone')
  const { performance: perf } = jest.requireActual('perf_hooks')
  let depth = 0
  const wrapped: any = (...args: any[]) => {
    cloneStats.calls++
    // Simulates the 66.1 branch's render without the bucket clone: once the
    // list is mounted (the merge memo is filled), clone returns its input.
    if ((global as any).__cloneIdentity) return args[0]
    if (depth > 0) return real(...args)
    depth++
    const t0 = perf.now()
    try {
      return real(...args)
    } finally {
      cloneStats.ms += perf.now() - t0
      depth--
    }
  }
  Object.assign(wrapped, real)
  return wrapped
})

const polyline = jest.requireActual('@mapbox/polyline')

function flatten(node: any, prefix = '', out: Record<string, string> = {}) {
  Object.entries(node || {}).forEach(([key, value]) => {
    const id = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out[id] = value
    else flatten(value, id, out)
  })
  return out
}
const messages = flatten(
  yaml.load(
    readFileSync(path.join(__dirname, '../../i18n/en-US.yml'), 'utf8')
  )
)

const CAPTURE = process.env.PERF_CAPTURE || `${PERF_CAPTURES_DIR}/capture5.json`
// Only read (a large JSON) when benchmarking and present; otherwise the specs skip.
const capture = RUN ? loadJson(CAPTURE) : null

/** A full app state holding the captured search, with the first `k` responses. */
function stateFor(k: number) {
  const base = getMockInitialState()
  const search = cloneDeep(capture.search)
  search.response = search.response.slice(0, k)
  search.pending = 0
  base.otp.config = {
    ...base.otp.config,
    co2: capture.config.co2,
    homeTimezone: capture.config.homeTimezone,
    itinerary: capture.config.itinerary
  }
  base.otp.filter = capture.filter
  base.otp.currentQuery = capture.currentQuery
  base.otp.searches = { [capture.activeSearchId]: search }
  base.otp.activeSearchId = capture.activeSearchId
  return base
}

/** The same code as NarrativeItineraries.render's groupedMergedItineraries. */
function groupLikeRender(mergedItineraries: any[], intl: any) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const clone = require('clone')
  return mergedItineraries.reduce(
    (prev, cur) => {
      const modeItinMap = clone(prev)
      const modeString = getItineraryDescription({
        combineTransitModes: true,
        intl,
        itinerary: cur
      } as any)
      const transitLegs = cur.legs.filter((l: any) => l.transitLeg)
      const modeContainer =
        transitLegs.length > 0 ? modeItinMap.multi : modeItinMap.single
      if (!modeContainer[modeString]) modeContainer[modeString] = []
      modeContainer[modeString].push(cur)
      return modeItinMap
    },
    { multi: {}, single: {} }
  )
}

describeBench(
  'T1 results screen: cost of a dispatch that does not touch the search',
  () => {
    jest.setTimeout(600000)
    beforeAll(() => {
      globalAny.fetch = () => new Promise(() => {})
      // jest's console capture is expensive and not what the phone pays.
      jest.spyOn(console, 'error').mockImplementation(() => {})
      jest.spyOn(console, 'warn').mockImplementation(() => {})
    })

    const n = capture ? capture.search.response.length : 0
    const ks = capture
      ? process.env.PERF_KS
        ? process.env.PERF_KS.split(',').map(Number)
        : Array.from(new Set([1, 2, 4, 6, 8, 10, n].filter((k) => k <= n)))
      : []

    ks.forEach((k) =>
      it(`responses[0..${k})`, () => {
        const state = stateFor(k)
        const itinCfg = state.otp.config.itinerary
        const itins = getActiveItineraries(state)
        const { allItineraries, mergedItineraries } = doMergeItineraries(
          itins,
          itinCfg.defaultFareType,
          itinCfg.mergeByRouteSignature
        )
        const respChars = JSON.stringify(
          state.otp.searches[capture.activeSearchId].response
        ).length
        note(
          `\n=== ${path.basename(CAPTURE)} responses=${k} itineraries=${
            itins.length
          } rows(merged)=${mergedItineraries.length} responseChars=${respChars}`
        )
        const variantTotal = mergedItineraries.reduce(
          (s: number, r: any) => s + (r.sameShapeVariants?.length || 0),
          0
        )
        note(
          `    sameShapeVariants total across rows: ${variantTotal}; allItineraries ${allItineraries.length}`
        )

        // --- mapStateToProps pieces, each on an unchanged search -------------
        const s2 = {
          ...state,
          otp: { ...state.otp, location: { ...state.otp.location } }
        }
        let a: any, b: any
        bench('  getActiveItineraries (reselect, same response)', () => {
          a = getActiveItineraries(s2)
        })
        note(`    -> same identity as before: ${a === itins}`)
        bench('  doMergeItineraries (memo hit)', () => {
          b = doMergeItineraries(
            a,
            itinCfg.defaultFareType,
            itinCfg.mergeByRouteSignature
          )
        })
        note(
          `    -> same mergedItineraries identity: ${
            b.mergedItineraries === mergedItineraries
          }`
        )
        bench('  sortItinerariesInPlaceIfNeeded', () =>
          sortItinerariesInPlaceIfNeeded(b.mergedItineraries, s2)
        )
        let d: any
        bench('  demoteTokenTransitHops', () => {
          d = demoteTokenTransitHops(b.mergedItineraries, {})
        })
        note(`    -> returns same array: ${d === b.mergedItineraries}`)
        let e1: any, e2: any
        bench('  getActiveSearchErrors', () => {
          e1 = getActiveSearchErrors(s2)
        })
        e2 = getActiveSearchErrors(s2)
        note(`    -> fresh object every call: ${e1 !== e2}`)
        let r1: any
        bench('  getRealtimeEffects', () => {
          r1 = getRealtimeEffects(s2)
        })
        note(`    -> fresh object every call: ${r1 !== getRealtimeEffects(s2)}`)

        // --- the render-time grouping reduce ---------------------------------
        const intl = {
          formatMessage: ({ id }: any, v?: any) =>
            `${id}${v ? JSON.stringify(v) : ''}`
        }
        cloneStats.calls = 0
        bench(
          `  render groupedMergedItineraries reduce (${mergedItineraries.length} rows)`,
          () => groupLikeRender(mergedItineraries, intl)
        )
        note(
          `    -> clone() calls (incl. recursion guard) per run ~ ${Math.round(
            cloneStats.calls / 8
          )}`
        )
        const bucketChars = JSON.stringify(
          mergedItineraries.map((r: any) => ({
            ...r,
            allStartTimes: undefined,
            sameShapeVariants: undefined
          }))
        ).length
        note(`    -> rows without variants serialise to ${bucketChars} chars`)

        // --- route preview overlay (mobile results map) ----------------------
        let p1: any, p2: any
        bench('  RoutePreviewOverlay mapStateToProps', () => {
          p1 = previewMapStateToProps(s2 as any)
        })
        p2 = previewMapStateToProps(s2 as any)
        note(
          `    -> visible=${p1.visible} geometries=${
            p1.geometries?.length
          } unique=${new Set(p1.geometries).size} fresh array every call: ${
            p1.geometries !== p2.geometries
          }`
        )
        bench(
          '  RoutePreviewOverlay render body (Set + polyline.toGeoJSON)',
          () => {
            const unique = Array.from(new Set(p1.geometries as string[]))
            unique.filter(Boolean).map((seg) => polyline.toGeoJSON(seg))
          }
        )
      })
    )

    ks.forEach((k) =>
      it(`mounted list, store.dispatch on responses[0..${k})`, () => {
        const state = stateFor(k)
        const otpReducer = createOtpReducer({})
        const root = (st: any, action: any) => {
          const otp = otpReducer(st.otp, action)
          return otp === st.otp ? st : { ...st, otp }
        }
        const store = createStore(root, state as any, applyMiddleware(thunk))
        // main.js:148's subscriber, as the app has it.
        let lastGoMode: any
        const saveStats = { calls: 0, ms: 0 }
        store.subscribe(() => {
          const goMode = (store.getState() as any).otp?.goMode
          if (goMode === lastGoMode) return
          lastGoMode = goMode
          if (goMode?.isActive && goMode.activeItinerary) {
            const t0 = Date.now()
            saveGoModeSession(goMode, 'sid', null)
            saveStats.calls++
            saveStats.ms += Date.now() - t0
          }
        })
        const commits: number[] = []
        const List = () => (
          <ComponentContext.Provider
            value={
              {
                ItineraryBody: MetroItinerary,
                LegIcon: ClassicLegIcon,
                ModeIcon: ClassicModeIcon
              } as any
            }
          >
            <React.Profiler
              id="list"
              onRender={(_id, _phase, actual) => commits.push(actual)}
            >
              <NarrativeItineraries />
            </React.Profiler>
          </ComponentContext.Provider>
        )
        const tm0 = Date.now()
        const wrapper = mount(
          <IntlProvider
            defaultLocale="en-US"
            locale="en-US"
            messages={messages}
          >
            <Provider store={store}>
              <List />
            </Provider>
          </IntlProvider>
        )
        const rows = wrapper.find('li.result').length
        note(
          `\n=== mounted: responses=${k} rows on screen=${rows} mount ${
            Date.now() - tm0
          } ms`
        )
        const rowRender = jest.spyOn(MetroItineraryClass.prototype, 'render')
        // Which props changed when a row re-rendered?
        const changedKeys = new Map<string, number>()
        const proto: any = MetroItineraryClass.prototype
        const prevCdu = proto.componentDidUpdate
        proto.componentDidUpdate = function (prevProps: any, ...rest: any[]) {
          Object.keys({ ...prevProps, ...this.props }).forEach((key) => {
            if (prevProps[key] !== this.props[key]) {
              changedKeys.set(key, (changedKeys.get(key) || 0) + 1)
            }
          })
          return prevCdu?.call(this, prevProps, ...rest)
        }

        const kinds: Array<[string, (i: number) => any]> = [
          [
            'POSITION_FETCHING',
            (i) => ({
              payload: { type: 'perf' + i },
              type: 'POSITION_FETCHING'
            })
          ],
          [
            'POSITION_RESPONSE',
            (i) => ({
              payload: {
                position: {
                  coords: { latitude: 44.9 + i * 1e-5, longitude: -93.2 }
                }
              },
              type: 'POSITION_RESPONSE'
            })
          ],
          [
            'ITINERARY_VARIANT_ROWS (no reducer)',
            () => ({ payload: {}, type: 'ITINERARY_VARIANT_ROWS' })
          ],
          [
            'SET_VISIBLE_ITINERARY',
            (i) => ({
              payload: { index: i % 2 ? 0 : null },
              type: 'SET_VISIBLE_ITINERARY'
            })
          ],
          // T3: beginGoMode's first dispatch lands while the results screen is
          // still mounted (SET_MOBILE_SCREEN comes after it). Alternate start/end
          // so every timed run is a real start.
          [
            'START_GO_MODE (results list still mounted)',
            (i) =>
              i % 2
                ? { type: 'STOP_GO_MODE' }
                : {
                    payload: {
                      itinerary: (store.getState() as any).otp.searches[
                        capture.activeSearchId
                      ].response[0].plan.itineraries[0],
                      multiStop: null,
                      originalFrom: null,
                      roundTrip: null
                    },
                    type: 'START_GO_MODE'
                  }
          ]
        ]
        const modes: Array<[string, boolean]> = [['', false]]
        if (process.env.PERF_NOCLONE)
          modes.push([' [render clone removed]', true])
        for (const [modeLabel, identity] of modes)
          for (const [label0, mk] of kinds) {
            const label = label0 + modeLabel
            globalAny.__cloneIdentity = identity
            rowRender.mockClear()
            saveStats.calls = 0
            saveStats.ms = 0
            cloneStats.calls = 0
            cloneStats.ms = 0
            commits.length = 0
            const med = bench(`  dispatch ${label}`, (i) =>
              store.dispatch(mk(i))
            )
            note(
              `    -> per dispatch: list commits=${(commits.length / 8).toFixed(
                1
              )} commitActual(med)=${
                commits.length
                  ? [...commits]
                      .sort((x, y) => x - y)
                      [Math.floor(commits.length / 2)].toFixed(1)
                  : 0
              } ms, MetroItinerary.render calls=${(
                rowRender.mock.calls.length / 8
              ).toFixed(1)}, clone() ${(cloneStats.ms / 8).toFixed(
                1
              )} ms of ${med.toFixed(1)}, saveGoModeSession ${
                saveStats.calls
              } calls ${saveStats.ms} ms`
            )
          }
        globalAny.__cloneIdentity = false
        // The thunk componentDidUpdate calls whenever mergedItineraries changes
        // identity (demoteTokenTransitHops returns a new array when it demotes).
        const rowsNow = (wrapper.find('NarrativeItineraries').props() as any)
          .mergedItineraries
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
          fillRouteRowTimetables
        } = require('../../lib/actions/route-row-timetable')
        bench('  fillRouteRowTimetables thunk, all rows already asked', () =>
          fillRouteRowTimetables(rowsNow)(() => {}, store.getState)
        )
        note(
          `    row props that changed across all dispatches: ${JSON.stringify(
            Array.from(changedKeys.entries())
          )}`
        )
        proto.componentDidUpdate = prevCdu
        rowRender.mockRestore()
        wrapper.unmount()
      })
    )
  }
)

// describeBench holds no test when the capture is absent: say so, with the path.
if (!RUN) {
  it.skip('results-dispatch benchmark (set PERF_BENCH=1 to run)', () =>
    undefined)
} else if (!capture) {
  it.skip(`results-dispatch benchmark (missing input: ${CAPTURE})`, () =>
    undefined)
}
