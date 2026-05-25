import type { Leg } from '@opentripplanner/types'

import type { TripProgress } from './progress-calculator'

export type NotificationType =
  | 'APPROACH_STOP'
  | 'ARRIVING_STOP'
  | 'UPCOMING_TURN'
  | 'LEG_TRANSITION'
  | 'DELAY_ALERT'
  | 'ROUTE_DEVIATION'
  | 'CONNECTION_WARNING'
  | 'TRIP_COMPLETE'

export interface NotificationConfig {
  enabled: boolean
  soundEnabled: boolean
  vibrationEnabled: boolean
}

export interface NotificationEvent {
  id: string
  message: string
  priority: 'low' | 'medium' | 'high'
  timestamp: Date
  title: string
  type: NotificationType
}

// Notification types that warrant proactively offering a re-route.
const AUTO_REROUTE_TRIGGER_TYPES: NotificationType[] = [
  'CONNECTION_WARNING',
  'ROUTE_DEVIATION'
]

/**
 * Whether to kick off an automatic re-route suggestion this update: a
 * connection-risk or off-route notification just fired and no re-route is
 * already in progress or awaiting the rider's decision (status must be 'idle').
 * The suggestion is surfaced as a Switch/Keep card — never an automatic swap.
 */
export function shouldAutoReroute(
  notifications: NotificationEvent[],
  reRouteStatus: string
): boolean {
  if (reRouteStatus !== 'idle') return false
  return notifications.some((n) => AUTO_REROUTE_TRIGGER_TYPES.includes(n.type))
}

/**
 * Generate unique ID for notification to prevent duplicates
 */
function generateNotificationId(
  type: NotificationType,
  context: string
): string {
  return `${type}_${context}_${Date.now()}`
}

/**
 * Check if notification was recently sent to prevent spam
 */
export function wasRecentlySent(
  notificationId: string,
  sentNotifications: string[],
  timeWindowMs = 60000
): boolean {
  // Extract timestamp from notification ID
  const parts = notificationId.split('_')
  const timestamp = parseInt(parts[parts.length - 1], 10)

  if (isNaN(timestamp)) return false

  const now = Date.now()

  // Check if this type/context was sent recently
  const similarNotifications = sentNotifications.filter((id) => {
    const idParts = id.split('_')
    const idTimestamp = parseInt(idParts[idParts.length - 1], 10)

    if (isNaN(idTimestamp)) return false

    // Same type and context
    return (
      id.startsWith(parts.slice(0, -1).join('_')) &&
      now - idTimestamp < timeWindowMs
    )
  })

  return similarNotifications.length > 0
}

/**
 * Trigger device vibration if supported and enabled
 */
export function triggerVibration(
  pattern: number | number[],
  config: NotificationConfig
): void {
  if (!config.vibrationEnabled) return

  if ('vibrate' in navigator) {
    navigator.vibrate(pattern)
  }
}

/**
 * Check if should notify for approaching stop
 */
export function checkApproachingStop(
  progress: TripProgress,
  currentLeg: Leg,
  sentNotifications: string[]
): NotificationEvent | null {
  if (
    progress.stopsRemaining === 2 &&
    (currentLeg.mode === 'BUS' || currentLeg.mode === 'RAIL')
  ) {
    const id = generateNotificationId(
      'APPROACH_STOP',
      `${currentLeg.routeShortName || currentLeg.routeLongName}_${
        progress.nextStopName
      }`
    )

    if (!wasRecentlySent(id, sentNotifications)) {
      return {
        id,
        message: `Get ready! Your stop (${currentLeg.to.name}) is 2 stops away.`,
        priority: 'high',
        timestamp: new Date(),
        title: 'Approaching Your Stop',
        type: 'APPROACH_STOP'
      }
    }
  }

  return null
}

/**
 * Check if should notify for arriving at stop
 */
export function checkArrivingStop(
  progress: TripProgress,
  currentLeg: Leg,
  sentNotifications: string[]
): NotificationEvent | null {
  if (
    progress.stopsRemaining === 1 &&
    (currentLeg.mode === 'BUS' || currentLeg.mode === 'RAIL')
  ) {
    const id = generateNotificationId(
      'ARRIVING_STOP',
      `${currentLeg.routeShortName || currentLeg.routeLongName}_${
        currentLeg.to.name
      }`
    )

    if (!wasRecentlySent(id, sentNotifications)) {
      return {
        id,
        message: `Prepare to exit at ${currentLeg.to.name}`,
        priority: 'high',
        timestamp: new Date(),
        title: 'Next Stop: Your Stop!',
        type: 'ARRIVING_STOP'
      }
    }
  }

  return null
}

/**
 * Check if should notify for upcoming turn
 */
export function checkUpcomingTurn(
  progress: TripProgress,
  currentLeg: Leg,
  sentNotifications: string[]
): NotificationEvent | null {
  if (
    (currentLeg.mode === 'WALK' || currentLeg.mode === 'BICYCLE') &&
    progress.distanceToNextTurn &&
    progress.distanceToNextTurn < 50 &&
    progress.distanceToNextTurn > 10
  ) {
    const id = generateNotificationId('UPCOMING_TURN', `${currentLeg.to.name}`)

    if (!wasRecentlySent(id, sentNotifications, 30000)) {
      return {
        id,
        message:
          progress.nextInstruction ||
          `In ${Math.round(progress.distanceToNextTurn)}m`,
        priority: 'medium',
        timestamp: new Date(),
        title: 'Turn Ahead',
        type: 'UPCOMING_TURN'
      }
    }
  }

  return null
}

/**
 * Check if should notify for leg transition
 */
export function checkLegTransition(
  currentLegIndex: number,
  previousLegIndex: number,
  nextLeg: Leg | undefined,
  sentNotifications: string[]
): NotificationEvent | null {
  if (currentLegIndex > previousLegIndex && nextLeg) {
    const id = generateNotificationId(
      'LEG_TRANSITION',
      `leg_${currentLegIndex}_${nextLeg.mode}`
    )

    if (!wasRecentlySent(id, sentNotifications, 30000)) {
      let message = ''

      if (nextLeg.mode === 'BUS' || nextLeg.mode === 'RAIL') {
        message = `Board ${
          nextLeg.routeShortName || nextLeg.routeLongName
        } to ${nextLeg.to.name}`
      } else if (nextLeg.mode === 'WALK') {
        message = `Walk to ${nextLeg.to.name}`
      } else {
        message = `Continue to ${nextLeg.to.name}`
      }

      return {
        id,
        message,
        priority: 'high',
        timestamp: new Date(),
        title: 'Next Step',
        type: 'LEG_TRANSITION'
      }
    }
  }

  return null
}

/**
 * Check if should notify for route deviation
 */
export function checkRouteDeviation(
  distanceFromRoute: number,
  sentNotifications: string[]
): NotificationEvent | null {
  if (distanceFromRoute > 200) {
    const id = generateNotificationId(
      'ROUTE_DEVIATION',
      `deviation_${Math.floor(distanceFromRoute)}`
    )

    if (!wasRecentlySent(id, sentNotifications, 120000)) {
      return {
        id,
        message: `You are ${Math.round(
          distanceFromRoute
        )}m from the planned route`,
        priority: 'high',
        timestamp: new Date(),
        title: 'Off Route',
        type: 'ROUTE_DEVIATION'
      }
    }
  }

  return null
}

const TRANSIT_MODES = ['BUS', 'RAIL', 'SUBWAY', 'TRAM', 'FERRY']

function isTransitMode(mode: string | undefined): boolean {
  return mode != null && TRANSIT_MODES.includes(mode)
}

// Minimum lateness before a connection warning is worth raising (seconds).
const CONNECTION_MIN_DELAY_SECONDS = 60
// Warn once the projected slack to the connecting departure drops below this.
const CONNECTION_SLACK_THRESHOLD_SECONDS = 120

/**
 * Find the next transit leg after the given index, summing any walk/transfer
 * time on the legs in between. Returns null when no onward transit leg exists.
 */
function findNextTransitConnection(
  legs: Leg[],
  fromIndex: number
): { leg: Leg; transferSeconds: number } | null {
  let transferSeconds = 0
  for (let i = fromIndex + 1; i < legs.length; i++) {
    if (isTransitMode(legs[i].mode)) {
      return { leg: legs[i], transferSeconds }
    }
    transferSeconds += legs[i].duration || 0
  }
  return null
}

/**
 * Build the user-facing copy for a connection warning.
 */
function connectionWarningCopy(
  routeName: string,
  stopName: string,
  delaySeconds: number,
  slackSeconds: number
): { message: string; title: string } {
  const atStop = stopName ? ` at ${stopName}` : ''
  if (slackSeconds < 0) {
    const lateMin = Math.max(1, Math.round(delaySeconds / 60))
    return {
      message: `Running ${lateMin} min late — you may miss ${routeName}${atStop}.`,
      title: 'Connection at risk'
    }
  }
  return {
    message: `Tight connection — about ${Math.round(
      slackSeconds
    )}s to catch ${routeName}${atStop}.`,
    title: 'Tight connection'
  }
}

/**
 * Check whether a downstream transfer is at risk because the current transit
 * leg is running late.
 *
 * Real-data only: `progress.delay` is the rider's measured GPS-vs-schedule lag
 * on the current leg. We project that lag forward to the transfer stop and
 * compare against the *planned* connecting departure (the connecting service's
 * own real-time delay is not yet accounted for — the warning is therefore
 * conservative and may over-warn if the connection is also late).
 */
export function checkConnectionWarning(
  progress: TripProgress,
  legs: Leg[],
  currentLegIndex: number,
  sentNotifications: string[]
): NotificationEvent | null {
  const currentLeg = legs[currentLegIndex]
  if (!currentLeg || !isTransitMode(currentLeg.mode)) return null

  // Only meaningful when the current leg is actually behind schedule.
  const delaySeconds = progress.delay ?? 0
  if (delaySeconds < CONNECTION_MIN_DELAY_SECONDS) return null

  const connection = findNextTransitConnection(legs, currentLegIndex)
  if (!connection) return null // no onward transit connection to miss
  const { leg: nextTransitLeg, transferSeconds } = connection

  // Project arrival at the transfer stop assuming the delay persists, then see
  // whether the rider can still reach the connecting departure in time.
  // Leg start/end times are typed number | string in @opentripplanner/types.
  const projectedArrivalMs = Number(currentLeg.endTime) + delaySeconds * 1000
  const slackSeconds =
    (Number(nextTransitLeg.startTime) - projectedArrivalMs) / 1000 -
    transferSeconds

  if (slackSeconds >= CONNECTION_SLACK_THRESHOLD_SECONDS) return null

  const routeName =
    nextTransitLeg.routeShortName ||
    nextTransitLeg.routeLongName ||
    'your connection'
  const stopName = nextTransitLeg.from?.name || currentLeg.to?.name || ''
  const id = generateNotificationId(
    'CONNECTION_WARNING',
    `${routeName}_${stopName}`
  )

  if (wasRecentlySent(id, sentNotifications, 120000)) return null

  const { message, title } = connectionWarningCopy(
    routeName,
    stopName,
    delaySeconds,
    slackSeconds
  )

  return {
    id,
    message,
    priority: 'high',
    timestamp: new Date(),
    title,
    type: 'CONNECTION_WARNING'
  }
}

// Minimum lateness on the current leg before alerting the rider (seconds).
const DELAY_ALERT_THRESHOLD_SECONDS = 180

/**
 * Check whether the transit leg the rider is currently on is running late
 * enough to warrant a heads-up.
 *
 * Real-data only: uses `progress.delay`, the measured GPS-vs-schedule lag on
 * the current leg. The alert id buckets the delay into 5-minute increments so
 * worsening lateness re-alerts (3 min, then 8 min, ...) without spamming on
 * small fluctuations within a bucket.
 */
export function checkDelayAlert(
  progress: TripProgress,
  currentLeg: Leg,
  sentNotifications: string[]
): NotificationEvent | null {
  if (!isTransitMode(currentLeg.mode)) return null

  const delaySeconds = progress.delay ?? 0
  if (delaySeconds < DELAY_ALERT_THRESHOLD_SECONDS) return null

  const routeName =
    currentLeg.routeShortName || currentLeg.routeLongName || 'Your ride'
  const lateMin = Math.max(1, Math.round(delaySeconds / 60))
  const bucket = Math.floor(delaySeconds / 300)
  const id = generateNotificationId('DELAY_ALERT', `${routeName}_${bucket}`)

  if (wasRecentlySent(id, sentNotifications, 300000)) return null

  return {
    id,
    message: `${routeName} is running about ${lateMin} min late.`,
    priority: 'medium',
    timestamp: new Date(),
    title: 'Running late',
    type: 'DELAY_ALERT'
  }
}

/**
 * Check if should notify for trip completion
 */
export function checkTripComplete(
  progress: TripProgress,
  sentNotifications: string[]
): NotificationEvent | null {
  if (progress.status === 'completed' || progress.overallProgress >= 99.5) {
    const id = generateNotificationId('TRIP_COMPLETE', 'trip_end')

    if (!wasRecentlySent(id, sentNotifications)) {
      return {
        id,
        message: 'You have arrived at your destination!',
        priority: 'medium',
        timestamp: new Date(),
        title: 'Trip Complete',
        type: 'TRIP_COMPLETE'
      }
    }
  }

  return null
}

/**
 * Append a notification to the list when one was produced.
 */
function pushIf(
  notifications: NotificationEvent[],
  event: NotificationEvent | null
): void {
  if (event) notifications.push(event)
}

/**
 * Process all notification checks and return any that should be triggered
 */
export function checkForNotifications(
  progress: TripProgress,
  currentLeg: Leg,
  previousLegIndex: number,
  nextLeg: Leg | undefined,
  distanceFromRoute: number,
  sentNotifications: string[],
  config: NotificationConfig,
  legs?: Leg[]
): NotificationEvent[] {
  if (!config.enabled) {
    return []
  }

  const notifications: NotificationEvent[] = []

  // Highest-priority, always-checked alerts.
  pushIf(
    notifications,
    checkApproachingStop(progress, currentLeg, sentNotifications)
  )
  pushIf(
    notifications,
    checkArrivingStop(progress, currentLeg, sentNotifications)
  )
  pushIf(
    notifications,
    checkLegTransition(
      progress.currentLegIndex,
      previousLegIndex,
      nextLeg,
      sentNotifications
    )
  )
  pushIf(
    notifications,
    checkRouteDeviation(distanceFromRoute, sentNotifications)
  )

  // At-risk downstream connection (needs the full leg list).
  const connectionWarning = legs
    ? checkConnectionWarning(
        progress,
        legs,
        progress.currentLegIndex,
        sentNotifications
      )
    : null
  pushIf(notifications, connectionWarning)

  // Running-late heads-up. Skipped when a connection warning already fired,
  // since that message conveys the lateness.
  if (!connectionWarning) {
    pushIf(
      notifications,
      checkDelayAlert(progress, currentLeg, sentNotifications)
    )
  }

  pushIf(notifications, checkTripComplete(progress, sentNotifications))

  // Lower priority: only surface a turn when nothing else is showing.
  if (notifications.length === 0) {
    pushIf(
      notifications,
      checkUpcomingTurn(progress, currentLeg, sentNotifications)
    )
  }

  return notifications
}

/**
 * Show notification to user (in-app toast/modal)
 */
export function showNotification(
  event: NotificationEvent,
  config: NotificationConfig
): void {
  // Trigger vibration for high priority notifications
  if (event.priority === 'high' && config.vibrationEnabled) {
    triggerVibration([200, 100, 200], config)
  }

  // Dispatch custom event that UI components can listen to
  const customEvent = new CustomEvent('go-mode-notification', {
    detail: event
  })
  window.dispatchEvent(customEvent)
}
