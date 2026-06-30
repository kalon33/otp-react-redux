/**
 * Emoji icon for a transit/active mode, shared across Go Mode UI (the active
 * leg header and the trip-overview sheet) so the two never drift apart.
 */
export function getModeIcon(mode: string): string {
  switch (mode) {
    case 'BUS':
      return '🚌'
    case 'RAIL':
      return '🚆'
    case 'SUBWAY':
      return '🚇'
    case 'TRAM':
      return '🚊'
    case 'FERRY':
      return '⛴️'
    case 'WALK':
      return '🚶'
    case 'BICYCLE':
      return '🚲'
    default:
      return '🚍'
  }
}
