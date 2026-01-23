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
 * Process all notification checks and return any that should be triggered
 */
export function checkForNotifications(
  progress: TripProgress,
  currentLeg: Leg,
  previousLegIndex: number,
  nextLeg: Leg | undefined,
  distanceFromRoute: number,
  sentNotifications: string[],
  config: NotificationConfig
): NotificationEvent[] {
  if (!config.enabled) {
    return []
  }

  const notifications: NotificationEvent[] = []

  // Check for approaching stop (highest priority)
  const approachingStop = checkApproachingStop(
    progress,
    currentLeg,
    sentNotifications
  )
  if (approachingStop) {
    notifications.push(approachingStop)
  }

  // Check for arriving at stop
  const arrivingStop = checkArrivingStop(
    progress,
    currentLeg,
    sentNotifications
  )
  if (arrivingStop) {
    notifications.push(arrivingStop)
  }

  // Check for leg transition
  const legTransition = checkLegTransition(
    progress.currentLegIndex,
    previousLegIndex,
    nextLeg,
    sentNotifications
  )
  if (legTransition) {
    notifications.push(legTransition)
  }

  // Check for route deviation
  const routeDeviation = checkRouteDeviation(
    distanceFromRoute,
    sentNotifications
  )
  if (routeDeviation) {
    notifications.push(routeDeviation)
  }

  // Check for trip completion
  const tripComplete = checkTripComplete(progress, sentNotifications)
  if (tripComplete) {
    notifications.push(tripComplete)
  }

  // Check for upcoming turn (lower priority, only if no other notifications)
  if (notifications.length === 0) {
    const upcomingTurn = checkUpcomingTurn(
      progress,
      currentLeg,
      sentNotifications
    )
    if (upcomingTurn) {
      notifications.push(upcomingTurn)
    }
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
