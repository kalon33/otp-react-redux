import { IntlProvider } from 'react-intl'
import { Provider } from 'react-redux'
import React from 'react'

import type { TripProgress } from '../../util/go-mode/progress-calculator'

import AlightRecommendation from './AlightRecommendation'
import TransitProgress from './TransitProgress'
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

const readyOnboard = (realtime: boolean) => ({
  bestAlightStop: {
    busArrivalEpoch: NOW + 11 * 60000,
    itinerary: { duration: 240, transfers: 1, walkDistance: 140 },
    realtime,
    stopId: '1:9',
    stopName: 'Nicollet Mall'
  },
  candidates: [],
  status: 'ready',
  trip: null,
  vehicle: null
})

const Frame = ({
  children,
  note,
  title
}: {
  children: React.ReactNode
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
        minHeight: 150,
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

      <Frame note="Plain access leg, no transit next." title="Walking only">
        <WalkingNavigation
          leg={walkLeg}
          onExit={() => undefined}
          progress={{
            ...baseProgress,
            nextInstruction: 'Head north on Hennepin'
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
        note="Get-there time carries the LIVE waves glyph."
        title="Alight recommendation, LIVE"
      >
        <Provider store={mockStore(readyOnboard(true))}>
          <AlightRecommendation />
        </Provider>
      </Frame>

      <Frame
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
    </div>
  </IntlProvider>
)

export default GoModeDemo
