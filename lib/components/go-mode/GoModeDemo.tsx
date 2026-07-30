// @ts-expect-error @opentripplanner/icons ships no type declarations
import { ClassicLegIcon } from '@opentripplanner/icons'
import { IntlProvider } from 'react-intl'
import { Provider } from 'react-redux'
import React from 'react'

import { ComponentContext } from '../../util/contexts'
import type { TripProgress } from '../../util/go-mode/progress-calculator'

import AlightRecommendation from './AlightRecommendation'
import TransitProgress from './TransitProgress'
import TripSheet from './TripSheet'
import WalkingNavigation from './WalkingNavigation'

/**
 * Static, self-contained gallery of every Go Mode card state, mounted with mock
 * data so the UI can be reviewed (and screenshotted) WITHOUT the GPS simulation,
 * the OTP backend, or the real Redux store. Reached at any app URL with the
 * `?goModeDemo=1` query param (see lib/app.js).
 *
 * This exists purely as a review harness. It deliberately brings its own Intl
 * and minimal Redux providers so it renders in isolation.
 */

const NOW = Date.now()
const SERVICE_DAY = Math.floor(NOW / 1000) - 4 * 3600 // ~service-day start

// A stop-time as returned by findStopTimesForStop, shaped for mergeAndSortStopTimes.
const stoptime = (depInMs: number, realtime: boolean, schedSkewMs = 0) => {
  const depSecs = Math.round((NOW + depInMs) / 1000) - SERVICE_DAY
  const schedSecs = depSecs + Math.round(schedSkewMs / 1000)
  return {
    headsign: 'Downtown',
    realtimeDeparture: realtime ? depSecs : null,
    realtimeState: realtime ? 'UPDATED' : 'SCHEDULED',
    scheduledDeparture: schedSecs,
    serviceDay: SERVICE_DAY,
    trip: {
      blockId: 'b1',
      pattern: { id: '1:21:0' },
      route: { gtfsId: '1:21' }
    }
  }
}

// boardingStopData for the boarding card: route 1:21 with a soon live departure
// plus later ones (mix of live + scheduled) to exercise the alternatives list.
const makeBoardingStopData = (live: boolean) => ({
  gtfsId: '1:1001',
  name: 'Lake St & Hennepin Ave',
  routes: [{ id: '1:21' }],
  stoptimesForPatterns: [
    {
      pattern: {
        desc: '21 to Downtown',
        id: '1:21:0',
        route: { gtfsId: '1:21' }
      },
      stoptimes: [
        stoptime(7 * 60000, live, 60000), // soonest catchable (~7 min)
        stoptime(19 * 60000, true), // later, live
        stoptime(31 * 60000, false), // later, scheduled
        stoptime(43 * 60000, true)
      ]
    }
  ]
})

const baseProgress: TripProgress = {
  currentLegIndex: 0,
  currentLegProgress: 0,
  currentTime: new Date(NOW),
  estimatedArrival: new Date(NOW + 25 * 60000),
  overallProgress: 10,
  plannedDepartureTime: NOW + 8 * 60000,
  status: 'onTime' as TripProgress['status'],
  timeRemaining: 1500,
  timeUntilNextDeparture: 420
}

const walkLeg = {
  duration: 360,
  from: { name: 'Your location' },
  mode: 'WALK',
  to: { name: 'Lake St & Hennepin Ave' }
} as any

const busNextLeg = {
  from: { name: 'Lake St & Hennepin Ave', stop: { gtfsId: '1:1001' } },
  mode: 'BUS',
  route: { id: '1:21' },
  routeShortName: '21',
  transitLeg: true
} as any

const onBusLeg = {
  duration: 900,
  from: { name: 'Lake St & Hennepin Ave' },
  mode: 'BUS',
  route: { id: '1:21', shortName: '21' },
  routeShortName: '21',
  to: { name: 'Nicollet Mall' },
  transitLeg: true
} as any

const transitProgress: TripProgress = {
  ...baseProgress,
  currentLegProgress: 45,
  nextStopName: '5th St S',
  stopsRemaining: 4
}

// A minimal Redux store so the connected AlightRecommendation can render with a
// fixed goMode state. dispatch is a no-op — buttons are inert in the gallery.
const mockStore = (onboard: any) =>
  ({
    dispatch: () => undefined,
    getState: () => ({ otp: { config: {}, goMode: { onboard } } }),
    subscribe: () => () => undefined
  } as any)

// Same idea for TransitProgress, which reads goMode.vehicleMatch.
const vehicleMatchStore = (vehicleMatch: any) =>
  ({
    dispatch: () => undefined,
    getState: () => ({ otp: { config: {}, goMode: { vehicleMatch } } }),
    subscribe: () => () => undefined
  } as any)

const readyOnboard = (realtime: boolean) => {
  // A ranked list of onward options (earliest arrival first), each a stop the
  // rider can pick to get off at.
  const alightOptions = [
    {
      busArrivalEpoch: NOW + 11 * 60000,
      itinerary: { duration: 240, transfers: 1, walkDistance: 140 },
      realtime,
      stopId: '1:9',
      stopName: 'Nicollet Mall'
    },
    {
      busArrivalEpoch: NOW + 13 * 60000,
      itinerary: { duration: 180, transfers: 0, walkDistance: 220 },
      realtime,
      stopId: '1:12',
      stopName: 'Government Plaza'
    },
    {
      busArrivalEpoch: NOW + 16 * 60000,
      itinerary: { duration: 120, transfers: 0, walkDistance: 300 },
      realtime,
      stopId: '1:15',
      stopName: 'Target Field'
    }
  ]
  return {
    alightOptions,
    bestAlightStop: alightOptions[0],
    candidates: [],
    status: 'ready',
    trip: null,
    vehicle: null
  }
}

// Multi-leg journey for the trip-overview sheet: walking to the stop → METRO
// Orange Line → walk. The rider is on the first walk leg, so the bus row shows
// a live wait before boarding. Shaped for the REAL ItineraryBody the sheet now
// renders, so walk legs carry `steps` and places carry lat/lon.
const walkStep = (relativeDirection: string, streetName: string) => ({
  absoluteDirection: 'NORTH',
  distance: 120,
  lat: 44.948,
  lon: -93.278,
  relativeDirection,
  streetName
})

const place = (name: string, lat: number, lon: number) => ({ lat, lon, name })

const demoSheetItinerary = {
  endTime: NOW + 28 * 60000,
  legs: [
    {
      distance: 400,
      duration: 300,
      endTime: NOW + 2 * 60000,
      from: place('Your location', 44.948, -93.278),
      intermediateStops: [],
      mode: 'WALK',
      startTime: NOW - 3 * 60000,
      steps: [
        walkStep('DEPART', 'Blaisdell Ave'),
        walkStep('LEFT', 'E Lake St')
      ],
      to: place('I-35W & Lake St Station', 44.948, -93.269)
    },
    {
      distance: 9000,
      duration: 900,
      // Bus departs 3 min after the rider reaches the stop.
      endTime: NOW + 20 * 60000,
      from: place('I-35W & Lake St Station', 44.948, -93.269),
      intermediateStops: [
        place('I-35W & 46th St Station', 44.919, -93.269),
        place('I-35W & 66th St Station', 44.891, -93.278)
      ],
      mode: 'BUS',
      routeShortName: 'METRO Orange Line',
      startTime: NOW + 5 * 60000,
      steps: [],
      to: place('I-35W & 82nd St Station', 44.86, -93.285),
      transitLeg: true
    },
    {
      distance: 300,
      duration: 240,
      endTime: NOW + 28 * 60000,
      from: place('I-35W & 82nd St Station', 44.86, -93.285),
      intermediateStops: [],
      mode: 'WALK',
      startTime: NOW + 20 * 60000,
      steps: [walkStep('DEPART', 'American Blvd')],
      to: place('Your destination', 44.859, -93.29)
    }
  ],
  startTime: NOW - 3 * 60000
} as any

// The trip sheet renders the trip through the real ItineraryBody, which pulls
// config and ui state off the store — so the demo store has to look enough like
// the app's for that whole subtree to mount.
const demoSheetStore = {
  dispatch: () => undefined,
  getState: () => ({
    otp: {
      config: {
        homeTimezone: 'America/Chicago',
        itinerary: { hideViewTripButton: true },
        transitOperators: []
      },
      goMode: {
        activeItinerary: demoSheetItinerary,
        // Live GTFS-realtime for the upcoming bus leg (index 1): running a
        // couple minutes late vs the plan, sourced by refreshLiveLegTimes.
        liveLegTimes: {
          1: {
            alightEpoch: NOW + 23 * 60000,
            alightRealtime: true,
            boardEpoch: NOW + 6 * 60000,
            boardRealtime: true,
            realtime: true
          }
        },
        progress: {
          ...transitProgress,
          // Walking to the stop; the next bus has a live 3-min wait.
          currentLegIndex: 0,
          waitTimeAtStop: 180
        },
        ui: { activeLeg: null, backgrounded: false, mapFollowUser: true }
      },
      ui: { diagramLeg: null }
    }
  }),
  subscribe: () => () => undefined
} as any

// LegIconWithA11y (inside the real ItineraryBody) pulls LegIcon off the
// component context that lib/app.js normally supplies.
const demoComponentContext = { LegIcon: ClassicLegIcon } as any

const Frame = ({
  children,
  minHeight = 150,
  note,
  title
}: {
  children: React.ReactNode
  minHeight?: number
  note?: string
  title: string
}) => (
  <div style={{ marginBottom: 28 }}>
    <div
      style={{ color: '#333', fontSize: 14, fontWeight: 700, marginBottom: 2 }}
    >
      {title}
    </div>
    {note && (
      <div style={{ color: '#888', fontSize: 12, marginBottom: 6 }}>{note}</div>
    )}
    <div
      style={{
        background: '#f2f3f5',
        border: '1px solid #ccc',
        borderRadius: 12,
        minHeight,
        overflow: 'hidden',
        position: 'relative',
        width: 390
      }}
    >
      {children}
    </div>
  </div>
)

const GoModeDemo = (): JSX.Element => (
  <IntlProvider
    defaultLocale="en-US"
    locale="en-US"
    messages={{
      'common.forms.back': 'Back',
      'components.StopTimeCell.realtime': 'Realtime',
      'components.StopTimeCell.scheduled': 'Scheduled'
    }}
    onError={() => undefined}
  >
    <div
      style={{
        background: '#fff',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
        minHeight: '100vh',
        padding: 24
      }}
    >
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Go Mode — card gallery</h1>

      <Frame
        note="Live realtime departure → green waves glyph left of the time; alternatives mix live + scheduled."
        title="Boarding (walk → bus), LIVE"
      >
        <WalkingNavigation
          boardingStopData={makeBoardingStopData(true)}
          leg={walkLeg}
          nextLeg={busNextLeg}
          onExit={() => undefined}
          onSelectDeparture={() => undefined}
          progress={baseProgress}
        />
      </Frame>

      <Frame
        note="No realtime → plain time, no glyph."
        title="Boarding (walk → bus), SCHEDULED"
      >
        <WalkingNavigation
          boardingStopData={makeBoardingStopData(false)}
          leg={walkLeg}
          nextLeg={busNextLeg}
          onExit={() => undefined}
          onSelectDeparture={() => undefined}
          progress={baseProgress}
        />
      </Frame>

      <Frame
        note="Turn-by-turn on a transit-bound access leg: the turn is the first foot, directly under 'arrives in'; the ride-to-stop line follows. Hero clock + waves untouched."
        title="Boarding (bike → bus), with turn"
      >
        <WalkingNavigation
          boardingStopData={makeBoardingStopData(true)}
          leg={{ ...walkLeg, mode: 'BICYCLE' }}
          nextLeg={busNextLeg}
          onExit={() => undefined}
          onSelectDeparture={() => undefined}
          progress={{
            ...baseProgress,
            distanceToNextTurn: 320,
            nextInstruction: 'Turn right on E Lake Nokomis Pkwy',
            nextTurnCue: {
              distanceMeters: 170,
              index: 1,
              instruction: 'Turn right on E Lake Nokomis Pkwy',
              offsetMeters: 822,
              relativeDirection: 'RIGHT',
              significant: true,
              streetName: 'E Lake Nokomis Pkwy'
            }
          }}
        />
      </Frame>

      <Frame
        note="Plain access leg, no transit next — turn-by-turn off leg.steps."
        title="Walking only"
      >
        <WalkingNavigation
          leg={walkLeg}
          onExit={() => undefined}
          progress={{
            ...baseProgress,
            distanceToNextTurn: 90,
            followingTurnCue: {
              distanceMeters: 300,
              index: 2,
              instruction: 'Turn right on East 40th Street',
              offsetMeters: 800,
              relativeDirection: 'RIGHT',
              significant: false,
              streetName: 'East 40th Street'
            },
            nextInstruction: 'Turn left on 2nd Avenue South',
            nextTurnCue: {
              distanceMeters: 160,
              index: 1,
              instruction: 'Turn left on 2nd Avenue South',
              offsetMeters: 500,
              relativeDirection: 'LEFT',
              significant: true,
              streetName: '2nd Avenue South'
            }
          }}
        />
      </Frame>

      <Frame note="On the bus, mid-leg progress." title="Transit progress">
        <TransitProgress
          leg={onBusLeg}
          onExit={() => undefined}
          progress={transitProgress}
        />
      </Frame>

      <Frame
        note="Route publishes no live vehicle positions (or its feed is down). Say so rather than spinning on 'Locating your bus...' forever — stop progress still comes from GPS."
        title="Transit progress, no live vehicle data"
      >
        <Provider store={vehicleMatchStore({ emptyPolls: 12, match: null })}>
          <TransitProgress
            leg={onBusLeg}
            onExit={() => undefined}
            progress={transitProgress}
          />
        </Provider>
      </Frame>

      <Frame
        minHeight={280}
        note="Ranked list of onward options, earliest arrival first. Get-there time carries the LIVE waves glyph."
        title="Alight recommendation, LIVE"
      >
        <Provider store={mockStore(readyOnboard(true))}>
          <AlightRecommendation />
        </Provider>
      </Frame>

      <Frame
        minHeight={280}
        note="Get-there time, no glyph."
        title="Alight recommendation, SCHEDULED"
      >
        <Provider store={mockStore(readyOnboard(false))}>
          <AlightRecommendation />
        </Provider>
      </Frame>

      <Frame
        note="Discovery in progress."
        title="Alight recommendation, finding bus"
      >
        <Provider
          store={mockStore({
            bestAlightStop: null,
            candidates: [],
            status: 'discovering',
            trip: null,
            vehicle: null
          })}
        >
          <AlightRecommendation />
        </Provider>
      </Frame>

      <Frame
        note="Swipe-up sheet: a 'right now' card (current leg, its stops, the live wait) above the planner's own ItineraryBody, fed live board/off times. Tapping a leg zooms the map. 'Search from here' hands over to the real results screen. Overlay is confined to this frame via a transform containing-block."
        title="Trip sheet (overview + search from here)"
      >
        <div style={{ height: 600, transform: 'translateZ(0)', width: '100%' }}>
          <Provider store={demoSheetStore}>
            <ComponentContext.Provider value={demoComponentContext}>
              <TripSheet onClose={() => undefined} />
            </ComponentContext.Provider>
          </Provider>
        </div>
      </Frame>
    </div>
  </IntlProvider>
)

export default GoModeDemo
