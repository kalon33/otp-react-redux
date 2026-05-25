import {
  checkApproachingStop,
  checkArrivingStop,
  checkConnectionWarning,
  checkDelayAlert,
  checkForNotifications,
  checkLegTransition,
  checkRouteDeviation,
  checkTripComplete,
  checkUpcomingTurn,
  shouldAutoReroute,
  triggerVibration,
  wasRecentlySent
} from '../../../lib/util/go-mode/notification-service'

const makeProgress = (overrides: Record<string, any> = {}) => ({
  currentLegIndex: 0,
  currentLegProgress: 50,
  estimatedArrival: new Date('2026-01-28T10:30:00'),
  overallProgress: 50,
  status: 'on_track' as const,
  timeRemaining: 600,
  ...overrides
})

const makeConfig = (overrides: Record<string, any> = {}) => ({
  enabled: true,
  soundEnabled: true,
  vibrationEnabled: true,
  ...overrides
})

describe('util > go-mode > notification-service', () => {
  describe('wasRecentlySent', () => {
    it('should return false for empty sent list', () => {
      const id = `APPROACH_STOP_route5_StopA_${Date.now()}`
      expect(wasRecentlySent(id, [])).toBe(false)
    })

    it('should return true when similar notification was sent recently', () => {
      const now = Date.now()
      const existingId = `APPROACH_STOP_route5_StopA_${now - 30000}` // 30s ago
      const newId = `APPROACH_STOP_route5_StopA_${now}`
      expect(wasRecentlySent(newId, [existingId])).toBe(true)
    })

    it('should return false when similar notification was sent long ago', () => {
      const now = Date.now()
      const existingId = `APPROACH_STOP_route5_StopA_${now - 120000}` // 2 min ago
      const newId = `APPROACH_STOP_route5_StopA_${now}`
      expect(wasRecentlySent(newId, [existingId])).toBe(false)
    })

    it('should respect custom time window', () => {
      const now = Date.now()
      const existingId = `APPROACH_STOP_route5_${now - 25000}` // 25s ago
      const newId = `APPROACH_STOP_route5_${now}`
      // 30s window - should be recent
      expect(wasRecentlySent(newId, [existingId], 30000)).toBe(true)
      // 20s window - should not be recent
      expect(wasRecentlySent(newId, [existingId], 20000)).toBe(false)
    })

    it('should not match different notification types', () => {
      const now = Date.now()
      const existingId = `ARRIVING_STOP_route5_${now - 30000}`
      const newId = `APPROACH_STOP_route5_${now}`
      expect(wasRecentlySent(newId, [existingId])).toBe(false)
    })

    it('should return false for invalid timestamp', () => {
      const id = 'APPROACH_STOP_route5_invalid'
      expect(wasRecentlySent(id, [])).toBe(false)
    })
  })

  describe('triggerVibration', () => {
    const originalNavigator = global.navigator

    beforeEach(() => {
      Object.defineProperty(global, 'navigator', {
        configurable: true,
        value: { vibrate: jest.fn() },
        writable: true
      })
    })

    afterEach(() => {
      Object.defineProperty(global, 'navigator', {
        configurable: true,
        value: originalNavigator,
        writable: true
      })
    })

    it('should call navigator.vibrate when enabled', () => {
      const config = makeConfig()
      triggerVibration([200, 100, 200], config)
      expect(navigator.vibrate).toHaveBeenCalledWith([200, 100, 200])
    })

    it('should not call navigator.vibrate when disabled', () => {
      const config = makeConfig({ vibrationEnabled: false })
      triggerVibration([200, 100, 200], config)
      expect(navigator.vibrate).not.toHaveBeenCalled()
    })

    it('should accept single number pattern', () => {
      const config = makeConfig()
      triggerVibration(200, config)
      expect(navigator.vibrate).toHaveBeenCalledWith(200)
    })
  })

  describe('checkApproachingStop', () => {
    it('should return notification when 2 stops remaining on BUS', () => {
      const progress = makeProgress({
        nextStopName: 'Stop B',
        stopsRemaining: 2
      })
      const leg = {
        mode: 'BUS',
        routeShortName: '5',
        to: { name: 'Destination' }
      } as any

      const result = checkApproachingStop(progress, leg, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('APPROACH_STOP')
      expect(result!.priority).toBe('high')
      expect(result!.message).toContain('2 stops away')
    })

    it('should return notification when 2 stops remaining on RAIL', () => {
      const progress = makeProgress({ stopsRemaining: 2 })
      const leg = {
        mode: 'RAIL',
        routeLongName: 'Blue Line',
        to: { name: 'Target Field' }
      } as any

      const result = checkApproachingStop(progress, leg, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('APPROACH_STOP')
    })

    it('should return null when not 2 stops remaining', () => {
      const progress = makeProgress({ stopsRemaining: 3 })
      const leg = {
        mode: 'BUS',
        routeShortName: '5',
        to: { name: 'Dest' }
      } as any
      expect(checkApproachingStop(progress, leg, [])).toBeNull()
    })

    it('should return null for WALK mode', () => {
      const progress = makeProgress({ stopsRemaining: 2 })
      const leg = { mode: 'WALK', to: { name: 'Dest' } } as any
      expect(checkApproachingStop(progress, leg, [])).toBeNull()
    })
  })

  describe('checkArrivingStop', () => {
    it('should return notification when 1 stop remaining on transit', () => {
      const progress = makeProgress({ stopsRemaining: 1 })
      const leg = {
        mode: 'BUS',
        routeShortName: '5',
        to: { name: 'My Stop' }
      } as any

      const result = checkArrivingStop(progress, leg, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('ARRIVING_STOP')
      expect(result!.message).toContain('My Stop')
    })

    it('should return null when more than 1 stop remaining', () => {
      const progress = makeProgress({ stopsRemaining: 2 })
      const leg = {
        mode: 'BUS',
        routeShortName: '5',
        to: { name: 'Dest' }
      } as any
      expect(checkArrivingStop(progress, leg, [])).toBeNull()
    })
  })

  describe('checkUpcomingTurn', () => {
    it('should return notification for WALK leg when close to turn', () => {
      const progress = makeProgress({
        distanceToNextTurn: 30,
        nextInstruction: 'Turn left on Main St'
      })
      const leg = { mode: 'WALK', to: { name: 'Bus Stop' } } as any

      const result = checkUpcomingTurn(progress, leg, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('UPCOMING_TURN')
      expect(result!.message).toBe('Turn left on Main St')
    })

    it('should return null when too far from turn', () => {
      const progress = makeProgress({ distanceToNextTurn: 100 })
      const leg = { mode: 'WALK', to: { name: 'Bus Stop' } } as any
      expect(checkUpcomingTurn(progress, leg, [])).toBeNull()
    })

    it('should return null when too close to turn', () => {
      const progress = makeProgress({ distanceToNextTurn: 5 })
      const leg = { mode: 'WALK', to: { name: 'Bus Stop' } } as any
      expect(checkUpcomingTurn(progress, leg, [])).toBeNull()
    })

    it('should return null for non-walk modes', () => {
      const progress = makeProgress({ distanceToNextTurn: 30 })
      const leg = { mode: 'BUS', to: { name: 'Stop' } } as any
      expect(checkUpcomingTurn(progress, leg, [])).toBeNull()
    })
  })

  describe('checkLegTransition', () => {
    it('should return notification when transitioning to a new leg', () => {
      const nextLeg = {
        mode: 'BUS',
        routeShortName: '5',
        to: { name: 'Downtown' }
      } as any

      const result = checkLegTransition(1, 0, nextLeg, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('LEG_TRANSITION')
      expect(result!.message).toContain('Board')
      expect(result!.message).toContain('5')
    })

    it('should return walk message for WALK legs', () => {
      const nextLeg = { mode: 'WALK', to: { name: 'Bus Stop' } } as any
      const result = checkLegTransition(1, 0, nextLeg, [])
      expect(result).not.toBeNull()
      expect(result!.message).toContain('Walk to Bus Stop')
    })

    it("should return null when leg index hasn't changed", () => {
      const nextLeg = { mode: 'BUS', to: { name: 'Stop' } } as any
      expect(checkLegTransition(0, 0, nextLeg, [])).toBeNull()
    })

    it('should return null when no next leg', () => {
      expect(checkLegTransition(1, 0, undefined, [])).toBeNull()
    })
  })

  describe('checkRouteDeviation', () => {
    it('should return notification when far from route', () => {
      const result = checkRouteDeviation(250, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('ROUTE_DEVIATION')
      expect(result!.priority).toBe('high')
      expect(result!.message).toContain('250m')
    })

    it('should return null when close to route', () => {
      expect(checkRouteDeviation(100, [])).toBeNull()
    })

    it('should return null when exactly at threshold', () => {
      expect(checkRouteDeviation(200, [])).toBeNull()
    })
  })

  describe('checkTripComplete', () => {
    it('should return notification when status is completed', () => {
      const progress = makeProgress({
        overallProgress: 100,
        status: 'completed'
      })
      const result = checkTripComplete(progress, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('TRIP_COMPLETE')
      expect(result!.message).toContain('arrived')
    })

    it('should return notification when progress >= 99.5', () => {
      const progress = makeProgress({
        overallProgress: 99.7,
        status: 'on_track'
      })
      const result = checkTripComplete(progress, [])
      expect(result).not.toBeNull()
    })

    it('should return null when trip is in progress', () => {
      const progress = makeProgress({ overallProgress: 50 })
      expect(checkTripComplete(progress, [])).toBeNull()
    })
  })

  describe('checkConnectionWarning', () => {
    const T = new Date('2026-01-28T10:00:00').getTime()
    // Bus 5 arrives the transfer stop at +10min, 2-min walk, bus 21 leaves +15min.
    const connectionLegs = [
      {
        endTime: T + 600000,
        mode: 'BUS',
        routeShortName: '5',
        startTime: T,
        to: { name: 'Transfer Center' }
      },
      { duration: 120, mode: 'WALK', to: { name: 'Bay 3' } },
      {
        from: { name: 'Transfer Center' },
        mode: 'BUS',
        routeShortName: '21',
        startTime: T + 900000
      }
    ] as any[]

    it('should warn when the connection will be missed', () => {
      // 10 min late: projected arrival (+20min) is past the +15min departure
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      const result = checkConnectionWarning(progress, connectionLegs, 0, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('CONNECTION_WARNING')
      expect(result!.priority).toBe('high')
      expect(result!.title).toBe('Connection at risk')
      expect(result!.message).toContain('21')
    })

    it('should warn (tight) when slack is small but positive', () => {
      // 90s late -> ~90s slack to the connection
      const progress = makeProgress({ currentLegIndex: 0, delay: 90 })
      const result = checkConnectionWarning(progress, connectionLegs, 0, [])
      expect(result).not.toBeNull()
      expect(result!.title).toBe('Tight connection')
      expect(result!.message).toContain('21')
    })

    it('should return null when there is ample slack', () => {
      // 60s late -> 120s slack, at/above the warning threshold
      const progress = makeProgress({ currentLegIndex: 0, delay: 60 })
      expect(checkConnectionWarning(progress, connectionLegs, 0, [])).toBeNull()
    })

    it('should return null when delay is below the minimum', () => {
      const progress = makeProgress({ currentLegIndex: 0, delay: 30 })
      expect(checkConnectionWarning(progress, connectionLegs, 0, [])).toBeNull()
    })

    it('should return null when the current leg is not transit', () => {
      const progress = makeProgress({ currentLegIndex: 1, delay: 600 })
      expect(checkConnectionWarning(progress, connectionLegs, 1, [])).toBeNull()
    })

    it('should return null when there is no onward transit connection', () => {
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      const noConnection = connectionLegs.slice(0, 2)
      expect(checkConnectionWarning(progress, noConnection, 0, [])).toBeNull()
    })

    it('should not re-warn within the dedup window', () => {
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      const recent = [
        `CONNECTION_WARNING_21_Transfer Center_${Date.now() - 30000}`
      ]
      expect(
        checkConnectionWarning(progress, connectionLegs, 0, recent)
      ).toBeNull()
    })
  })

  describe('checkDelayAlert', () => {
    const transitLeg = {
      mode: 'BUS',
      routeShortName: '5',
      to: { name: 'Downtown' }
    } as any

    it('should alert when the current leg is late beyond the threshold', () => {
      const progress = makeProgress({ currentLegIndex: 0, delay: 240 })
      const result = checkDelayAlert(progress, transitLeg, [])
      expect(result).not.toBeNull()
      expect(result!.type).toBe('DELAY_ALERT')
      expect(result!.priority).toBe('medium')
      expect(result!.title).toBe('Running late')
      expect(result!.message).toContain('4 min late')
      expect(result!.message).toContain('5')
    })

    it('should return null when delay is below the threshold', () => {
      const progress = makeProgress({ currentLegIndex: 0, delay: 120 })
      expect(checkDelayAlert(progress, transitLeg, [])).toBeNull()
    })

    it('should return null for a non-transit leg', () => {
      const walkLeg = { mode: 'WALK', to: { name: 'Stop' } } as any
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      expect(checkDelayAlert(progress, walkLeg, [])).toBeNull()
    })

    it('should not re-alert within the same delay bucket', () => {
      const progress = makeProgress({ currentLegIndex: 0, delay: 240 })
      const recent = [`DELAY_ALERT_5_0_${Date.now() - 30000}`]
      expect(checkDelayAlert(progress, transitLeg, recent)).toBeNull()
    })

    it('should re-alert when lateness escalates to a new bucket', () => {
      // Previously alerted at bucket 0 (<5 min); now 10 min late -> bucket 2
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      const recent = [`DELAY_ALERT_5_0_${Date.now() - 30000}`]
      const result = checkDelayAlert(progress, transitLeg, recent)
      expect(result).not.toBeNull()
      expect(result!.message).toContain('10 min late')
    })
  })

  describe('checkForNotifications', () => {
    it('should return empty array when notifications are disabled', () => {
      const progress = makeProgress({ stopsRemaining: 2 })
      const leg = {
        mode: 'BUS',
        routeShortName: '5',
        to: { name: 'Dest' }
      } as any
      const config = makeConfig({ enabled: false })

      const result = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        10,
        [],
        config
      )
      expect(result).toEqual([])
    })

    it('should return approach stop notification', () => {
      const progress = makeProgress({
        nextStopName: 'Stop B',
        stopsRemaining: 2
      })
      const leg = {
        mode: 'BUS',
        routeShortName: '5',
        to: { name: 'Destination' }
      } as any
      const config = makeConfig()

      const result = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        10,
        [],
        config
      )
      expect(result.length).toBeGreaterThan(0)
      expect(result.some((n) => n.type === 'APPROACH_STOP')).toBe(true)
    })

    it('should return route deviation notification', () => {
      const progress = makeProgress()
      const leg = { mode: 'WALK', to: { name: 'Dest' } } as any
      const config = makeConfig()

      const result = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        300,
        [],
        config
      )
      expect(result.some((n) => n.type === 'ROUTE_DEVIATION')).toBe(true)
    })

    it('should return trip complete notification', () => {
      const progress = makeProgress({
        overallProgress: 100,
        status: 'completed'
      })
      const leg = { mode: 'WALK', to: { name: 'Dest' } } as any
      const config = makeConfig()

      const result = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        10,
        [],
        config
      )
      expect(result.some((n) => n.type === 'TRIP_COMPLETE')).toBe(true)
    })

    it('should only include upcoming turn when no other notifications', () => {
      const progress = makeProgress({
        distanceToNextTurn: 30,
        nextInstruction: 'Turn left'
      })
      const leg = { mode: 'WALK', to: { name: 'Bus Stop' } } as any
      const config = makeConfig()

      const result = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        10, // close to route, no deviation
        [],
        config
      )
      // Should include upcoming turn since no higher priority notifications
      expect(result.some((n) => n.type === 'UPCOMING_TURN')).toBe(true)
    })

    it('should include a connection warning when legs are provided', () => {
      const T = new Date('2026-01-28T10:00:00').getTime()
      const legs = [
        {
          endTime: T + 600000,
          mode: 'BUS',
          routeShortName: '5',
          startTime: T,
          to: { name: 'Transfer Center' }
        },
        { duration: 120, mode: 'WALK', to: { name: 'Bay 3' } },
        {
          from: { name: 'Transfer Center' },
          mode: 'BUS',
          routeShortName: '21',
          startTime: T + 900000
        }
      ] as any[]
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      const config = makeConfig()

      const result = checkForNotifications(
        progress,
        legs[0],
        0,
        legs[1],
        10,
        [],
        config,
        legs
      )
      expect(result.some((n) => n.type === 'CONNECTION_WARNING')).toBe(true)
    })

    it('should not raise a connection warning when legs are omitted', () => {
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      const leg = {
        endTime: 0,
        mode: 'BUS',
        routeShortName: '5',
        startTime: 0,
        to: { name: 'Transfer Center' }
      } as any
      const config = makeConfig()

      const result = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        10,
        [],
        config
      )
      expect(result.some((n) => n.type === 'CONNECTION_WARNING')).toBe(false)
    })

    it('should include a delay alert when late with no connection at risk', () => {
      const leg = {
        endTime: 0,
        mode: 'BUS',
        routeShortName: '5',
        startTime: 0,
        to: { name: 'Downtown' }
      } as any
      const progress = makeProgress({ currentLegIndex: 0, delay: 300 })
      const config = makeConfig()

      const result = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        10,
        [],
        config,
        [leg] // single transit leg -> no onward connection
      )
      expect(result.some((n) => n.type === 'DELAY_ALERT')).toBe(true)
      expect(result.some((n) => n.type === 'CONNECTION_WARNING')).toBe(false)
    })

    it('should suppress the delay alert when a connection warning fires', () => {
      const T = new Date('2026-01-28T10:00:00').getTime()
      const legs = [
        {
          endTime: T + 600000,
          mode: 'BUS',
          routeShortName: '5',
          startTime: T,
          to: { name: 'Transfer Center' }
        },
        { duration: 120, mode: 'WALK', to: { name: 'Bay 3' } },
        {
          from: { name: 'Transfer Center' },
          mode: 'BUS',
          routeShortName: '21',
          startTime: T + 900000
        }
      ] as any[]
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      const config = makeConfig()

      const result = checkForNotifications(
        progress,
        legs[0],
        0,
        legs[1],
        10,
        [],
        config,
        legs
      )
      expect(result.some((n) => n.type === 'CONNECTION_WARNING')).toBe(true)
      expect(result.some((n) => n.type === 'DELAY_ALERT')).toBe(false)
    })
  })
})

describe('shouldAutoReroute', () => {
  const makeEvent = (type: any): any => ({
    id: `${type}_1`,
    message: 'm',
    priority: 'high',
    timestamp: new Date(),
    title: 't',
    type
  })

  it('fires for a connection warning when idle', () => {
    expect(shouldAutoReroute([makeEvent('CONNECTION_WARNING')], 'idle')).toBe(
      true
    )
  })

  it('fires for an off-route deviation when idle', () => {
    expect(shouldAutoReroute([makeEvent('ROUTE_DEVIATION')], 'idle')).toBe(true)
  })

  it('does not fire when a re-route is already in progress or shown', () => {
    expect(
      shouldAutoReroute([makeEvent('CONNECTION_WARNING')], 'searching')
    ).toBe(false)
    expect(shouldAutoReroute([makeEvent('ROUTE_DEVIATION')], 'found')).toBe(
      false
    )
  })

  it('ignores non-triggering notifications', () => {
    expect(shouldAutoReroute([makeEvent('APPROACH_STOP')], 'idle')).toBe(false)
    expect(shouldAutoReroute([], 'idle')).toBe(false)
  })
})
