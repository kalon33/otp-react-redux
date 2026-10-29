import { connect } from 'react-redux'
import { CSSTransition, TransitionGroup } from 'react-transition-group'
import { isMobile } from '@opentripplanner/core-utils/lib/ui'
import { useIntl } from 'react-intl'
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import styled, { keyframes } from 'styled-components'
import type { IntlShape } from 'react-intl'
import type { Itinerary } from '@opentripplanner/types'

import * as autoArmActions from '../../actions/auto-arm'
import * as goModeActions from '../../actions/go-mode'
import { autoPresetLabel } from '../go-mode/auto-preset-copy'
import { isWaitingForDeparture } from '../../util/go-mode/waiting-at-stop'
import { legBoard, liveArrivalMs } from '../../util/go-mode/live-itinerary'
import { MobileScreens } from '../../actions/ui-constants'
import AutoArmCard from '../go-mode/AutoArmCard'
import useActiveTripGuards from '../go-mode/use-active-trip-guards'
import type { AutoArm } from '../../util/go-mode/auto-arm'
import type { AutoPreset } from '../../util/go-mode/auto-priority'
import type { GoModeState } from '../../reducers/go-mode'
import type { LiveLegTime } from '../../util/go-mode/types'

import { BANNER_HEIGHT_VAR, usePublishedBannerHeight } from './banner-strip'

/**
 * The height the strip under the app bar is currently taking — this banner's
 * plus, while offline, the network strip's above it (75.16; banner-strip.ts) —
 * published so the fixed-position screens underneath can start below it
 * instead of behind it. Read as
 * `calc(50px + var(--return-to-trip-banner-height, 0px))` in mobile.css and in
 * the mobile screens' styled-components, and as the `padding-top` of AppFrame's
 * `main` in app.css (`#otp > main`) for the pages routed outside the
 * mobile-screen tree — /feedback, /settings, saved places. The fallback means
 * nothing moves when no banner is up.
 */
export { BANNER_HEIGHT_VAR }

const containerClassname = 'return-to-trip-banner'
const timeout = 250

// Same slide-in recipe as network-connection-banner: a 40px live-tint strip
// under the app bar with a pulsing live dot (Go Mode is running).
const pulseDot = keyframes`
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
`

const TransitionStyles = styled.div`
  .${containerClassname} {
    align-items: center;
    background-color: var(--tn-live-soft);
    border: 0;
    box-shadow: inset 0 -1px 0 var(--tn-border);
    color: var(--tn-text);
    cursor: pointer;
    display: flex;
    font: 600 14px/18px var(--tn-font);
    gap: 8px;
    justify-content: center;
    min-height: 40px;
    padding: 8px 16px;
    /* Absolute so the banner sits in the strip directly under the fixed nav
       bar. It does NOT get to overlap what is below it: its measured height is
       published as --return-to-trip-banner-height and every screen below adds
       it — mobile screens to their top offset, AppFrame pages to their
       padding-top — so the strip is vacated rather than covered. */
    position: absolute;
    text-align: center;
    /* Under the network-lost strip when that is up too (75.16): both used to
       sit at 50px, one over the other. */
    top: calc(50px + var(--network-banner-height, 0px));
    width: 100%;
    // When banner is fully loaded, set z-index higher than nav so we're not seeing the nav border.
    z-index: 26;

    &::before {
      animation: ${pulseDot} 2s ease-in-out infinite;
      background-color: var(--tn-live);
      border-radius: 50%;
      content: '';
      flex: none;
      height: 8px;
      width: 8px;
    }
    &:active {
      filter: brightness(0.96);
    }
    &:focus-visible {
      outline: 2px solid var(--tn-accent);
      outline-offset: -2px;
    }
  }
  .${containerClassname}-enter {
    opacity: 0;
    transform: translateY(-100%);
  }
  .${containerClassname}-enter-active {
    opacity: 1;
    transform: translateY(0);
    transition: opacity ${timeout}ms ease-in;
  }
  .${containerClassname}-exit {
    opacity: 1;
    transform: translateY(0);
    z-index: 20;
  }
  .${containerClassname}-exit-active {
    opacity: 0;
    transform: translateY(-100%);
    transition: opacity ${timeout}ms ease-in, transform ${timeout}ms ease-in;
    z-index: 20;
  }
`

/**
 * The platform wait, or null when the rider is not in one.
 *
 * `departureMs` is null when the only epoch on offer is a FLOOR (17.6) — the
 * wait is still a fact, the time is not one.
 */
function platformWait({
  activeItinerary,
  currentLegIndex,
  liveLegTimes,
  ridingLegIndex
}: Pick<
  TripProps,
  'activeItinerary' | 'currentLegIndex' | 'liveLegTimes' | 'ridingLegIndex'
>): { departureMs: number | null; stop: string } | null {
  const legIndex = currentLegIndex ?? 0
  const leg = activeItinerary?.legs?.[legIndex]
  if (!leg) return null
  const board = legBoard(legIndex, leg, liveLegTimes || {})
  const epoch = Number(board.epoch)
  const departureMs = Number.isFinite(epoch) ? epoch : null
  const waiting = isWaitingForDeparture({
    aboard: ridingLegIndex === legIndex,
    departureMs,
    leg,
    nowMs: Date.now()
  })
  if (!waiting || !leg.from?.name) return null
  return {
    departureMs: board.isFloor ? null : departureMs,
    stop: leg.from.name
  }
}

/**
 * "Waiting at <stop> · <departure>", or just the stop when the only epoch on
 * offer is a FLOOR — "no earlier than this" rather than a prediction (17.6),
 * which gates the wording but may not be printed as a departure time.
 */
function waitingMessage(
  intl: IntlShape,
  stop: string,
  departureMs: number | null
): string {
  if (departureMs == null) {
    return intl.formatMessage(
      {
        defaultMessage: 'Waiting at {stop} — tap to return',
        id: 'components.GoMode.returnBannerWaiting'
      },
      { stop }
    )
  }
  return intl.formatMessage(
    {
      defaultMessage: 'Waiting at {stop} · {time} — tap to return',
      id: 'components.GoMode.returnBannerWaitingTime'
    },
    {
      stop,
      time: new Date(departureMs).toLocaleTimeString(intl.locale, {
        hour: 'numeric',
        minute: '2-digit'
      })
    }
  )
}

/**
 * What the banner shows, read from the store field by field — never the whole
 * `goMode` slice. Every tick replaces `goMode.tracking` and `goMode.progress`,
 * so a banner handed the slice re-rendered on every dispatch, and each render
 * deep-cloned the itinerary for the arrival clock even while hidden: 35 ms
 * self / 106 ms total over 30 ticks of gold-74-1105 at 1x, mounted on every
 * screen (backlog 66.10, perf agent P7, 2026-10-29). A hidden banner now takes
 * nothing that moves (`HIDDEN`), so the ticks never reach it.
 */
interface TripProps {
  activeItinerary: Itinerary | null
  arm: AutoArm | null
  arrivedAt: number | null
  currentLegIndex: number | null
  /** `progress.estimatedArrival` as epoch ms (a fresh Date every tick). */
  estimatedArrivalMs: number | null
  liveLegTimes: Record<number, LiveLegTime> | null
  nextStopName: string | null
  ridingLegIndex: number | null
  visible: boolean
}

interface Props extends TripProps {
  cancelArm: () => void
  returnToGoMode: () => void
  setArmPreset: (preset: AutoPreset) => void
}

const HIDDEN: TripProps = {
  activeItinerary: null,
  arm: null,
  arrivedAt: null,
  currentLegIndex: null,
  estimatedArrivalMs: null,
  liveLegTimes: null,
  nextStopName: null,
  ridingLegIndex: null,
  visible: false
}

/**
 * Persistent "you're still on a trip" banner, shown under the nav bar on every
 * screen while an active Go Mode trip is backgrounded (rider browsing the
 * planner). Shows live next-stop/ETA context and returns to the Go Mode
 * screen on tap. Also keeps the active-trip guards (wake lock, reload
 * warning) alive while the Go Mode screen is unmounted.
 */
const ReturnToTripBanner = ({
  activeItinerary,
  arm,
  arrivedAt,
  cancelArm,
  currentLegIndex,
  estimatedArrivalMs,
  liveLegTimes,
  nextStopName,
  returnToGoMode,
  ridingLegIndex,
  setArmPreset,
  visible
}: Props): JSX.Element => {
  const intl = useIntl()
  const bannerRef = useRef<HTMLButtonElement>(null)
  const [armCardOpen, setArmCardOpen] = useState(false)

  useActiveTripGuards(visible)

  // The SAME arrival the trip sheet prints — the end of buildLiveItinerary's
  // last leg — not `progress.estimatedArrival`.
  //
  // On 2026-09-08 (session mtsvo7ss-4nzccy, 11:29) this banner said "Arrive
  // 11:50 AM" while the sheet said 11:57 and the rider actually arrived at
  // 11:58:08. `progress.estimatedArrival` is `now + timeRemaining`, and
  // timeRemaining is anchored on `liveTripEndMs` = live alight of the current
  // transit leg PLUS the sum of the later legs' `duration`
  // (progress-calculator.ts). A duration sum has no room for the WAIT between
  // legs, so every transfer is silently spent: leg 0 alighted live at 11:41:09,
  // the walk and the 546 ride are 532 s of moving time, and 11:41:09 + 532 s is
  // exactly the 11:50:01 recorded on every tick — the eight minutes standing at
  // the stop for the 546 (boarded 11:51:20) had vanished. buildLiveItinerary
  // anchors instead of summing (72c5296fc), so it keeps the gaps and lands on
  // the sheet's figure. Falls back to estimatedArrival when there is no
  // itinerary to fold live times into — and since 2026-09-17 that fallback is
  // sound too: `liveTripEndMs` walks the tail instead of summing it, so the
  // same ride now yields 11:58:26 (backlog 12.22, progress-calculator.ts's
  // `projectTripEndMs`). This still reads the sheet's own figure first,
  // because two ways of saying the same thing must not be allowed to drift.
  //
  // Folded once per itinerary / live-times change, not per render: the fold
  // deep-clones the itinerary, and the inputs change every ~30 s at most
  // while the ticks re-render a shown banner every second (66.10). A hidden
  // banner has no itinerary (HIDDEN) and folds nothing.
  const sheetArrival = useMemo(
    () =>
      activeItinerary
        ? liveArrivalMs(activeItinerary, liveLegTimes || {})
        : null,
    [activeItinerary, liveLegTimes]
  )
  const liveArrival = sheetArrival ?? estimatedArrivalMs

  // The platform wait (13.9). The trip steps onto a transit leg before the bus
  // leaves — 13.1 keeps that transition early on purpose, because advanceToLeg
  // is the only place startVehicleTracking runs for a mid-trip transit leg —
  // so `progress.nextStopName` is the stop AFTER the boarding stop for the
  // whole wait, and the branch below states it as a ride in progress. The card
  // stopped doing that on 2026-09-17 (TransitProgress, `gomode/card-truth`);
  // this banner was the same claim on a different surface and kept making it.
  //
  // Same predicate as the card, imported rather than restated: before the
  // bus's own departure time nobody can be riding it, and past that time the
  // old wording returns, so a rider aboard a bus the feed never confirmed is
  // never told they are waiting.
  const wait =
    visible && arrivedAt == null
      ? platformWait({
          activeItinerary,
          currentLegIndex,
          liveLegTimes,
          ridingLegIndex
        })
      : null

  let message: string
  if (arm) {
    message =
      arm.status === 'starting'
        ? intl.formatMessage({
            defaultMessage: 'Starting your trip…',
            id: 'components.GoMode.autoArm.bannerStarting'
          })
        : intl.formatMessage(
            {
              defaultMessage:
                'Starts when you leave · Auto · {preset} — tap to change',
              id: 'components.GoMode.autoArm.banner'
            },
            { preset: autoPresetLabel(arm.preset, intl) }
          )
  } else if (arrivedAt != null) {
    message = intl.formatMessage({
      defaultMessage: "You've arrived — tap to finish",
      id: 'components.GoMode.returnBannerArrived'
    })
  } else if (wait) {
    message = waitingMessage(intl, wait.stop, wait.departureMs)
  } else if (nextStopName && liveArrival != null) {
    message = intl.formatMessage(
      {
        defaultMessage:
          'On trip · Next stop {stop} · Arrive {eta} — tap to return',
        id: 'components.GoMode.returnBannerLive'
      },
      {
        eta: new Date(liveArrival).toLocaleTimeString(intl.locale, {
          hour: 'numeric',
          minute: '2-digit'
        }),
        stop: nextStopName
      }
    )
  } else {
    // GPS still (re)acquiring — e.g. right after a reload mid-trip.
    message = intl.formatMessage({
      defaultMessage: 'Trip in progress — tap to return',
      id: 'components.GoMode.returnBannerNoProgress'
    })
  }

  // Publish the banner's real height so the screens below can start under it
  // (banner-strip.ts: measured, because the copy wraps on a narrow phone).
  usePublishedBannerHeight('returnToTrip', bannerRef, visible, message)

  return (
    <TransitionStyles>
      <TransitionGroup style={{ display: 'content' }}>
        {visible && (
          <CSSTransition
            classNames={containerClassname}
            nodeRef={bannerRef}
            timeout={timeout}
          >
            <button
              className={containerClassname}
              onClick={arm ? () => setArmCardOpen(true) : returnToGoMode}
              ref={bannerRef}
              // The armed strip opens a card: a full 40 px target (B4).
              style={arm ? { minHeight: 40 } : undefined}
              type="button"
            >
              {message}
            </button>
          </CSSTransition>
        )}
      </TransitionGroup>
      {arm && armCardOpen && (
        <AutoArmCard
          armed={{
            expiresAtMs: arm.expiresAtMs,
            starting: arm.status === 'starting'
          }}
          onCancel={() => {
            setArmCardOpen(false)
            cancelArm()
          }}
          onClose={() => setArmCardOpen(false)}
          onPick={setArmPreset}
          preset={arm.preset}
        />
      )}
    </TransitionStyles>
  )
}

const mapStateToProps = (state: any): TripProps => {
  const goMode: GoModeState | undefined = state.otp.goMode
  const mobileScreen: number = state.otp.ui.mobileScreen
  // `backgrounded` is the deliberate step-out (backgroundGoMode, the app menu,
  // browseFromCurrentPosition) and stays the primary signal. The second clause
  // is the safety net: on a phone, ANY screen other than Go Mode while a trip
  // is running means the rider is looking at something else and needs a way
  // back, whether or not the code that moved them remembered to arm the flag.
  // On 2026-09-03 (session mtlutz2c-mfb2nx) a from-location change dropped a
  // live trip onto the bare search form with the flag unset and no route back.
  // Desktop is excluded: there the Go Mode screen is chosen by
  // `isActive && !backgrounded` (responsive-webapp), not by mobileScreen, so
  // reading mobileScreen there would show the banner over the trip screen.
  const strandedOnMobile = isMobile() && mobileScreen !== MobileScreens.GO_MODE
  const tripVisible = Boolean(
    goMode?.isActive &&
      goMode.activeItinerary &&
      (goMode.ui?.backgrounded || strandedOnMobile)
  )
  // "Start when I leave" (65.2 B4): with no trip running, an armed one holds
  // the same strip on every screen, and the same guards — the screen stays on
  // (foreground arming only) and a stray reload asks first.
  const arm = !goMode?.isActive ? goMode?.arm ?? null : null
  // Hidden — foreground Go Mode, i.e. most of every ride: one constant object,
  // so connect's shallow compare stops every tick here (66.10).
  if (!tripVisible && !arm) return HIDDEN
  const progress = goMode?.progress
  return {
    activeItinerary: goMode?.activeItinerary ?? null,
    arm,
    arrivedAt: goMode?.arrivedAt ?? null,
    currentLegIndex: progress?.currentLegIndex ?? null,
    estimatedArrivalMs: progress?.estimatedArrival
      ? new Date(progress.estimatedArrival).getTime()
      : null,
    liveLegTimes: goMode?.liveLegTimes ?? null,
    nextStopName: progress?.nextStopName ?? null,
    ridingLegIndex: goMode?.riding?.legIndex ?? null,
    visible: true
  }
}

const mapDispatchToProps = {
  cancelArm: autoArmActions.cancelArm,
  returnToGoMode: goModeActions.returnToGoMode,
  setArmPreset: autoArmActions.setArmPreset
}

export default connect(mapStateToProps, mapDispatchToProps)(ReturnToTripBanner)
