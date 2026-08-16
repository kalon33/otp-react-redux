import {
  checkAlightAlerts,
  checkConnectionWarning,
  checkDelayAlert,
  checkForNotifications,
  checkLegTransition,
  checkMissedBus,
  checkRouteDeviation,
  checkTripComplete,
  checkUpcomingTurn,
  classifyMissedBus,
  getEffectiveBoardTimeMs,
  resetTurnAnnouncements,
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
  // The turn latch lives for the life of a leg OBJECT; these tests reuse a
  // handful of leg literals across cases, so clear it between them.
  beforeEach(() => {
    resetTurnAnnouncements()
  })

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

  describe('checkAlightAlerts', () => {
    const busLeg = {
      mode: 'BUS',
      routeShortName: '5',
      startTime: 1769610000000,
      to: { name: 'My Stop' }
    } as any

    it('warns once about 2 minutes out', () => {
      const result = checkAlightAlerts(
        makeProgress(),
        busLeg,
        { distanceMetres: 3000, etaSeconds: 110 },
        []
      )
      expect(result).not.toBeNull()
      expect(result!.type).toBe('APPROACH_STOP')
      expect(result!.priority).toBe('high')
      expect(result!.message).toContain('My Stop')
    })

    it('says nothing while the stop is still far off', () => {
      expect(
        checkAlightAlerts(
          makeProgress(),
          busLeg,
          { distanceMetres: 6000, etaSeconds: 400 },
          []
        )
      ).toBeNull()
    })

    it('raises the door alert as arrival gets close', () => {
      const result = checkAlightAlerts(
        makeProgress(),
        busLeg,
        { distanceMetres: 900, etaSeconds: 20 },
        []
      )
      expect(result!.type).toBe('ARRIVING_STOP')
      expect(result!.message).toContain('My Stop')
    })

    it('raises the door alert on GPS proximity when the prediction is stale', () => {
      const result = checkAlightAlerts(
        makeProgress({ currentLegProgress: 95 }),
        busLeg,
        { distanceMetres: 120, etaSeconds: 240 },
        []
      )
      expect(result!.type).toBe('ARRIVING_STOP')
    })

    it('ignores proximity early in the leg (a route that loops back)', () => {
      expect(
        checkAlightAlerts(
          makeProgress({ currentLegProgress: 10 }),
          busLeg,
          { distanceMetres: 120, etaSeconds: 900 },
          []
        )
      ).toBeNull()
    })

    // The 7/22 complaint: stopsRemaining sat at 1 for minutes and the old
    // level+60s-window trigger re-fired every minute. Each stage must fire
    // exactly once no matter how long the rider lingers in range.
    it('fires each stage exactly once across a whole approach', () => {
      const sent: string[] = []
      const emitted: string[] = []
      // Every 15 s from 5 minutes out to arrival.
      for (let eta = 300; eta >= 0; eta -= 15) {
        const event = checkAlightAlerts(
          makeProgress({ currentLegProgress: 90 }),
          busLeg,
          { distanceMetres: eta * 8, etaSeconds: eta },
          sent
        )
        if (event) {
          emitted.push(event.type)
          sent.push(event.id)
        }
      }
      expect(emitted).toEqual(['APPROACH_STOP', 'ARRIVING_STOP'])
    })

    it('returns null for WALK mode', () => {
      const leg = { mode: 'WALK', startTime: 1, to: { name: 'Dest' } } as any
      expect(
        checkAlightAlerts(
          makeProgress(),
          leg,
          { distanceMetres: 10, etaSeconds: 5 },
          []
        )
      ).toBeNull()
    })
  })

  describe('checkUpcomingTurn', () => {
    const makeCue = (overrides: Record<string, any> = {}) => ({
      distanceMeters: 200,
      index: 1,
      instruction: 'Turn left on Main St',
      offsetMeters: 400,
      relativeDirection: 'LEFT',
      significant: false,
      streetName: 'Main St',
      ...overrides
    })

    const turnProgress = (distance: number, cue: Record<string, any> = {}) =>
      makeProgress({
        distanceToNextTurn: distance,
        nextInstruction: 'Turn left on Main St',
        nextTurnCue: makeCue(cue)
      })

    const walkLeg = {
      mode: 'WALK',
      startTime: 1,
      to: { name: 'Bus Stop' }
    } as any
    const bikeLeg = {
      mode: 'BICYCLE',
      startTime: 1,
      to: { name: 'Bus Stop' }
    } as any

    it('leads with the instruction so a watch never truncates it away', () => {
      const result = checkUpcomingTurn(turnProgress(30), walkLeg, [])
      expect(result).not.toBeNull()
      expect(result!.title).toBe('Turn left on Main St')
      expect(result!.message).toMatch(/ft/)
    })

    it('gives a cyclist a far earlier prepare cue than a walker', () => {
      // 100 m: too far to matter on foot, the right moment on a bike.
      expect(checkUpcomingTurn(turnProgress(100), walkLeg, [])).toBeNull()
      expect(checkUpcomingTurn(turnProgress(100), bikeLeg, [])).not.toBeNull()
    })

    it('should return null when too far from turn', () => {
      expect(checkUpcomingTurn(turnProgress(300), bikeLeg, [])).toBeNull()
    })

    it('still fires at the corner itself, where the old floor went silent', () => {
      const result = checkUpcomingTurn(turnProgress(5), walkLeg, [])
      expect(result).not.toBeNull()
    })

    it('should return null for non-walk modes', () => {
      const leg = { mode: 'BUS', startTime: 1, to: { name: 'Stop' } } as any
      expect(checkUpcomingTurn(turnProgress(30), leg, [])).toBeNull()
    })

    it('returns null when the leg produced no cue', () => {
      const progress = makeProgress({ distanceToNextTurn: 30 })
      expect(checkUpcomingTurn(progress, walkLeg, [])).toBeNull()
    })

    it('only a significant turn becomes the pushed TURN_ALERT type', () => {
      const routine = checkUpcomingTurn(turnProgress(100), bikeLeg, [])
      expect(routine!.type).toBe('UPCOMING_TURN')

      // A different turn on the same leg — the latch is per (cue, stage), so
      // two probes of the SAME cue would be one announcement, not two.
      const notable = checkUpcomingTurn(
        turnProgress(100, { index: 2, significant: true }),
        bikeLeg,
        []
      )
      expect(notable!.type).toBe('TURN_ALERT')
    })

    it('drops back to a silent type for the act cue of a significant turn', () => {
      // The buzz already went out at the prepare distance; buzzing again at the
      // corner is the spam this design exists to avoid.
      const act = checkUpcomingTurn(
        turnProgress(20, { significant: true }),
        bikeLeg,
        []
      )
      expect(act!.type).toBe('UPCOMING_TURN')
    })

    it('dedups on the turn, not the distance, as the rider closes on it', () => {
      const first = checkUpcomingTurn(turnProgress(110), bikeLeg, [])
      expect(first).not.toBeNull()
      // A tick later the distance differs but it is the same turn and stage.
      const second = checkUpcomingTurn(turnProgress(105), bikeLeg, [first!.id])
      expect(second).toBeNull()
    })

    it('announces a different turn even while the last one is deduped', () => {
      const first = checkUpcomingTurn(turnProgress(110), bikeLeg, [])
      const other = checkUpcomingTurn(
        turnProgress(110, { index: 2, instruction: 'Turn right on Oak' }),
        bikeLeg,
        [first!.id]
      )
      expect(other).not.toBeNull()
      expect(other!.title).toBe('Turn right on Oak')
    })

    it('stays silent while announcements are held, even inside act range', () => {
      // A rejoin/jump settle (7/29): the on-screen cue is right, the buzz
      // waits until the projection proves plausible.
      const held = makeProgress({
        distanceToNextTurn: 10,
        nextTurnCue: makeCue(),
        turnAnnouncementsHeld: true
      })
      expect(checkUpcomingTurn(held, bikeLeg, [])).toBeNull()
      expect(checkUpcomingTurn(held, walkLeg, [])).toBeNull()
    })

    describe('speed-scaled leads', () => {
      it('widens the bike prepare lead at real riding speed', () => {
        // 7/29 on-route speed: at 7 m/s the static 120 m floor is ~17 s of
        // warning; the scaled lead (7 × 25 = 175 m) catches a cue at 160 m.
        const fast = makeProgress({
          distanceToNextTurn: 160,
          nextTurnCue: makeCue(),
          riderSpeedMps: 7
        })
        expect(checkUpcomingTurn(fast, bikeLeg, [])).not.toBeNull()
        // Static leads would not have fired here.
        const noSpeed = makeProgress({
          distanceToNextTurn: 160,
          nextTurnCue: makeCue()
        })
        expect(checkUpcomingTurn(noSpeed, bikeLeg, [])).toBeNull()
      })

      it('leaves a walker unchanged — the floors win at walking speed', () => {
        // 1.4 × 25 = 35 m, under the 40 m walk floor: byte-identical behavior.
        const walker = makeProgress({
          distanceToNextTurn: 100,
          nextTurnCue: makeCue(),
          riderSpeedMps: 1.4
        })
        expect(checkUpcomingTurn(walker, walkLeg, [])).toBeNull()
      })

      it('caps the leads so a downhill sprint cannot announce blocks early', () => {
        // 10 × 25 = 250 m — exactly the cap; anything beyond stays silent.
        const downhill = (distance: number) =>
          makeProgress({
            distanceToNextTurn: distance,
            nextTurnCue: makeCue(),
            riderSpeedMps: 10
          })
        expect(checkUpcomingTurn(downhill(260), bikeLeg, [])).toBeNull()
        expect(checkUpcomingTurn(downhill(240), bikeLeg, [])).not.toBeNull()
      })

      it('scales the act stage too, within its own cap', () => {
        // 7 × 8 = 56 m: an act-stage cue at 50 m instead of the static 30 m.
        const fast = makeProgress({
          distanceToNextTurn: 50,
          nextTurnCue: makeCue(),
          riderSpeedMps: 7
        })
        const result = checkUpcomingTurn(fast, bikeLeg, [])
        expect(result).not.toBeNull()
        expect(result!.id).toContain('_act_')
      })
    })

    describe('once per turn — the 7/31 notification storm', () => {
      // 7/31: the rider stood at the origin 21 minutes early and got the same
      // "Turn right on Village Lane" pushed 14 times in 7 minutes, one every
      // 30.5 s, because the only guard was a 30 s window. "I specifically asked
      // for notifications to be once."
      let nowMs = 1785516757402
      let dateNowSpy: jest.SpyInstance

      beforeEach(() => {
        nowMs = 1785516757402
        dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs)
      })

      afterEach(() => {
        dateNowSpy.mockRestore()
      })

      it('never announces the same turn and stage twice, however long the wait', () => {
        const sent: string[] = []
        const first = checkUpcomingTurn(turnProgress(110), bikeLeg, sent)
        expect(first).not.toBeNull()
        sent.push(first!.id)

        // Past the 30 s rate-limiter window — the exact moment the old code
        // re-armed. Thirteen more of these made up the storm.
        nowMs += 31000
        expect(checkUpcomingTurn(turnProgress(108), bikeLeg, sent)).toBeNull()
        nowMs += 300000
        expect(checkUpcomingTurn(turnProgress(112), bikeLeg, sent)).toBeNull()
      })

      it('emits prepare and act exactly once each across a whole approach', () => {
        const sent: string[] = []
        const stages: string[] = []
        // A bike closing on the corner at ~4 m/s, one tick per second.
        for (let distance = 200; distance >= 0; distance -= 4) {
          nowMs += 1000
          const event = checkUpcomingTurn(
            makeProgress({
              distanceToNextTurn: distance,
              nextTurnCue: makeCue(),
              riderSpeedMps: 4
            }),
            bikeLeg,
            sent
          )
          if (event) {
            sent.push(event.id)
            stages.push(event.id.split('_')[4])
          }
        }
        expect(stages).toEqual(['prepare', 'act'])
      })

      it('says nothing to a rider who is standing still, then speaks when they move', () => {
        const sent: string[] = []
        const parked = () =>
          makeProgress({
            distanceToNextTurn: 53, // the 7/31 rider's pinned distance
            nextTurnCue: makeCue({ significant: true }),
            riderSpeedMps: 0.2
          })

        const events: (string | null)[] = []
        for (let tick = 0; tick < 8; tick++) {
          nowMs += 4000
          const event = checkUpcomingTurn(parked(), bikeLeg, sent)
          if (event) sent.push(event.id)
          events.push(event && event.type)
        }
        expect(events.filter(Boolean)).toEqual([])

        // They push off. The cue is actionable now, and lands once.
        nowMs += 4000
        const moving = makeProgress({
          distanceToNextTurn: 53,
          nextTurnCue: makeCue({ significant: true }),
          riderSpeedMps: 4
        })
        const first = checkUpcomingTurn(moving, bikeLeg, sent)
        expect(first).not.toBeNull()
        expect(first!.type).toBe('TURN_ALERT')
        sent.push(first!.id)

        nowMs += 31000
        expect(checkUpcomingTurn(moving, bikeLeg, sent)).toBeNull()
      })

      it('gives a rider who stops briefly their cue anyway', () => {
        // A red light is not being parked: the hold only bites after
        // STATIONARY_HOLD_TICKS consecutive slow ticks following real motion.
        const sent: string[] = []
        nowMs += 1000
        checkUpcomingTurn(
          makeProgress({
            distanceToNextTurn: 300,
            nextTurnCue: makeCue(),
            riderSpeedMps: 5
          }),
          bikeLeg,
          sent
        )
        nowMs += 1000
        const atTheLight = checkUpcomingTurn(
          makeProgress({
            distanceToNextTurn: 110,
            nextTurnCue: makeCue(),
            riderSpeedMps: 0.1
          }),
          bikeLeg,
          sent
        )
        expect(atTheLight).not.toBeNull()
      })

      it('never holds on a missing speed — absent data is not evidence of stillness', () => {
        // The 7/31 track's first 15 fixes carried speed: null.
        const sent: string[] = []
        for (let tick = 0; tick < 6; tick++) {
          nowMs += 4000
          checkUpcomingTurn(
            makeProgress({
              distanceToNextTurn: 300,
              nextTurnCue: makeCue(),
              riderSpeedMps: null
            }),
            bikeLeg,
            sent
          )
        }
        nowMs += 4000
        const event = checkUpcomingTurn(
          makeProgress({
            distanceToNextTurn: 110,
            nextTurnCue: makeCue(),
            riderSpeedMps: null
          }),
          bikeLeg,
          sent
        )
        expect(event).not.toBeNull()
      })

      it('still gives a slow walker their one cue at the corner', () => {
        // Under 0.7 m/s for the whole approach, so the prepare cue is held —
        // but the act stage at the junction is exempt while nothing has been
        // said about this turn yet.
        const sent: string[] = []
        const creep = (distance: number) =>
          makeProgress({
            distanceToNextTurn: distance,
            nextTurnCue: makeCue(),
            riderSpeedMps: 0.4
          })

        const emitted: string[] = []
        for (const distance of [38, 30, 24, 18, 12, 8, 4]) {
          nowMs += 4000
          const event = checkUpcomingTurn(creep(distance), walkLeg, sent)
          if (event) {
            sent.push(event.id)
            emitted.push(event.id.split('_')[4])
          }
        }
        expect(emitted).toEqual(['act'])
      })

      it('re-arms for a new leg object — the latch lives and dies with the leg', () => {
        const sent: string[] = []
        const first = checkUpcomingTurn(turnProgress(110), bikeLeg, sent)
        expect(first).not.toBeNull()
        sent.push(first!.id)
        expect(checkUpcomingTurn(turnProgress(110), bikeLeg, sent)).toBeNull()

        // An itinerary swap (reroute, missed-bus auto-update) hands back new
        // leg objects; the rider still needs guiding on the replacement leg.
        // Past the backstop window, since that is what a real swap looks like.
        nowMs += 31000
        const replanned = {
          mode: 'BICYCLE',
          startTime: 2,
          to: { name: 'Bus Stop' }
        } as any
        expect(
          checkUpcomingTurn(turnProgress(110), replanned, sent)
        ).not.toBeNull()
      })
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

    it('reacts sooner on a bike, where 200m of drift takes seconds', () => {
      const bikeLeg = { mode: 'BICYCLE' } as any
      expect(checkRouteDeviation(150, [], bikeLeg)).not.toBeNull()
      // The same distance on foot is still within the walking allowance.
      expect(checkRouteDeviation(150, [], { mode: 'WALK' } as any)).toBeNull()
    })

    it('still absorbs GPS scatter and parallel bike paths', () => {
      expect(
        checkRouteDeviation(100, [], { mode: 'BICYCLE' } as any)
      ).toBeNull()
    })

    it('should dedup repeated deviations even as the distance changes', () => {
      const sent: string[] = []
      let fired = 0
      // Simulate a minute of once-per-second GPS ticks drifting 204m -> 263m.
      for (let i = 0; i < 60; i++) {
        const result = checkRouteDeviation(204 + i, sent)
        if (result) {
          fired++
          sent.push(result.id)
        }
      }
      expect(fired).toBe(1)
    })

    it('should fire again after the 120s window expires', () => {
      const staleId = `ROUTE_DEVIATION_deviation_${Date.now() - 121000}`
      expect(checkRouteDeviation(250, [staleId])).not.toBeNull()
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

    it('should stay deduped while deviation ids share the sent list', () => {
      const progress = makeProgress({
        overallProgress: 100,
        status: 'completed'
      })
      const sent = [`TRIP_COMPLETE_trip_end_${Date.now() - 1000}`]
      for (let i = 0; i < 30; i++) {
        sent.push(`ROUTE_DEVIATION_deviation_${Date.now() - i * 1000}`)
      }
      expect(checkTripComplete(progress, sent)).toBeNull()
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
      const progress = makeProgress({ nextStopName: 'Stop B' })
      const leg = {
        mode: 'BUS',
        routeShortName: '5',
        startTime: 1769610000000,
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
        config,
        [leg],
        { distanceMetres: 2000, etaSeconds: 100 }
      )
      expect(result.length).toBeGreaterThan(0)
      expect(result.some((n) => n.type === 'APPROACH_STOP')).toBe(true)
    })

    it('raises no alight alert without an alight context', () => {
      const leg = {
        mode: 'BUS',
        routeShortName: '5',
        startTime: 1769610000000,
        to: { name: 'Destination' }
      } as any
      const result = checkForNotifications(
        makeProgress(),
        leg,
        0,
        undefined,
        10,
        [],
        makeConfig()
      )
      expect(
        result.some(
          (n) => n.type === 'APPROACH_STOP' || n.type === 'ARRIVING_STOP'
        )
      ).toBe(false)
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

    it('should include an upcoming turn', () => {
      const progress = makeProgress({
        distanceToNextTurn: 30,
        nextInstruction: 'Turn left',
        nextTurnCue: {
          distanceMeters: 200,
          index: 1,
          instruction: 'Turn left',
          offsetMeters: 400,
          relativeDirection: 'LEFT',
          significant: false,
          streetName: 'Main St'
        }
      })
      const leg = {
        mode: 'WALK',
        startTime: 1,
        to: { name: 'Bus Stop' }
      } as any
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
      expect(result.some((n) => n.type === 'UPCOMING_TURN')).toBe(true)
    })

    it('keeps guiding the rider through a co-occurring low-priority alert', () => {
      // Turn cues used to be suppressed by ANY other notification. Now that
      // they are real navigation, only a missed bus or an at-risk connection —
      // alerts that mean "stop following this leg" — can silence them.
      const progress = makeProgress({
        currentLegProgress: 95,
        distanceToNextTurn: 30,
        nextInstruction: 'Turn left',
        nextStopName: 'Stop B',
        nextTurnCue: {
          distanceMeters: 200,
          index: 1,
          instruction: 'Turn left',
          offsetMeters: 400,
          relativeDirection: 'LEFT',
          significant: false,
          streetName: 'Main St'
        },
        stopsRemaining: 1
      })
      const leg = {
        mode: 'WALK',
        startTime: 1,
        to: { name: 'Bus Stop' }
      } as any

      const result = checkForNotifications(
        progress,
        leg,
        0,
        undefined,
        // Far enough off the polyline to raise a deviation in the same tick.
        400,
        [],
        makeConfig()
      )
      expect(result.some((n) => n.type === 'ROUTE_DEVIATION')).toBe(true)
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

  it("retries after a settled empty attempt ('none') — one dud reroute must not disable deviation response for the rest of the ride", () => {
    expect(shouldAutoReroute([makeEvent('ROUTE_DEVIATION')], 'none')).toBe(true)
    expect(shouldAutoReroute([makeEvent('CONNECTION_WARNING')], 'none')).toBe(
      true
    )
  })

  it('ignores non-triggering notifications', () => {
    expect(shouldAutoReroute([makeEvent('APPROACH_STOP')], 'idle')).toBe(false)
    expect(shouldAutoReroute([], 'idle')).toBe(false)
  })
})

describe('missed-bus detection', () => {
  // Board time for the transit leg; other times are relative to it.
  const BOARD = 1783783824000
  const STOP = {
    lat: 44.817,
    lon: -93.31039,
    name: 'Old Shakopee Rd & Queen Ave S',
    stop: { gtfsId: '1:stop-queen' }
  }
  // ~23m from the stop (today's ride: rider pinned near, not at, the stop)
  const NEAR_STOP: [number, number] = [44.816793, -93.310211]
  // ~500m away — clearly not at the stop
  const FAR_AWAY: [number, number] = [44.8125, -93.31039]

  const makeLegs = (): any[] => [
    {
      duration: 600,
      endTime: BOARD - 10000,
      from: { lat: 44.8168, lon: -93.3103, name: 'Queen Av S' },
      mode: 'WALK',
      startTime: BOARD - 610000,
      to: STOP
    },
    {
      duration: 300,
      endTime: BOARD + 300000,
      from: STOP,
      mode: 'BUS',
      routeShortName: '546',
      startTime: BOARD,
      to: { lat: 44.8318, lon: -93.2985, name: '98th St W & Logan Ave S' },
      transitLeg: true
    },
    {
      duration: 200,
      endTime: BOARD + 500000,
      from: { lat: 44.8318, lon: -93.2985, name: '98th St W & Logan Ave S' },
      mode: 'WALK',
      startTime: BOARD + 300000,
      to: { lat: 44.825177, lon: -93.302367, name: 'Bloomington City Hall' }
    }
  ]

  const baseInput = (overrides: Record<string, any> = {}): any => ({
    currentLegIndex: 0,
    departureOverrideMs: null,
    legs: makeLegs(),
    liveLegTimes: {},
    nowMs: BOARD,
    riderPosition: NEAR_STOP,
    riderSpeedMps: 0,
    riding: null,
    vehicleConfidence: undefined,
    ...overrides
  })

  describe('getEffectiveBoardTimeMs', () => {
    const leg = makeLegs()[1]

    it('prefers a realtime board epoch over everything', () => {
      expect(
        getEffectiveBoardTimeMs(
          leg,
          { boardEpoch: BOARD + 60000, realtime: true },
          BOARD + 120000
        )
      ).toEqual({ ms: BOARD + 60000, realtime: true })
    })

    it('ignores a schedule-quality live entry and falls to the override', () => {
      expect(
        getEffectiveBoardTimeMs(
          leg,
          { boardEpoch: BOARD + 60000, realtime: false },
          BOARD + 120000
        )
      ).toEqual({ ms: BOARD + 120000, realtime: false })
    })

    it('falls back to the scheduled leg start', () => {
      expect(getEffectiveBoardTimeMs(leg, undefined, null)).toEqual({
        ms: BOARD,
        realtime: false
      })
    })
  })

  describe('classifyMissedBus', () => {
    it('returns null while the departure is still ahead', () => {
      expect(classifyMissedBus(baseInput({ nowMs: BOARD - 60000 }))).toBeNull()
    })

    it('returns null within the schedule-only grace (bus may just be late)', () => {
      expect(classifyMissedBus(baseInput({ nowMs: BOARD + 120000 }))).toBeNull()
    })

    it('schedule-only past grace while AT the stop -> ambiguous miss', () => {
      const ctx = classifyMissedBus(baseInput({ nowMs: BOARD + 200000 }))
      expect(ctx).not.toBeNull()
      expect(ctx!.definitive).toBe(false)
      expect(ctx!.boardLegIndex).toBe(1)
    })

    it('schedule-only past grace while far from the stop -> definitive miss', () => {
      const ctx = classifyMissedBus(
        baseInput({ nowMs: BOARD + 200000, riderPosition: FAR_AWAY })
      )
      expect(ctx?.definitive).toBe(true)
    })

    it('realtime says the bus left + grace -> definitive even at the stop (the 07-11 ride)', () => {
      const ctx = classifyMissedBus(
        baseInput({
          liveLegTimes: { 1: { boardEpoch: BOARD, realtime: true } },
          nowMs: BOARD + 100000
        })
      )
      expect(ctx?.definitive).toBe(true)
      expect(ctx?.realtime).toBe(true)
      expect(ctx?.effectiveBoardMs).toBe(BOARD)
    })

    it('realtime board epoch still in the future (late bus) -> no miss', () => {
      const ctx = classifyMissedBus(
        baseInput({
          liveLegTimes: { 1: { boardEpoch: BOARD + 300000, realtime: true } },
          nowMs: BOARD + 200000
        })
      )
      expect(ctx).toBeNull()
    })

    it('rider already riding the leg -> null', () => {
      expect(
        classifyMissedBus(
          baseInput({ nowMs: BOARD + 200000, riding: { legIndex: 1 } })
        )
      ).toBeNull()
    })

    it('riding held on a PRIOR leg still means aboard — no miss for a later boarding', () => {
      // 7/29: the riding fact is the rider's chosen bus; while it is held (it
      // only clears after 90s sustained off-route) no boarding anywhere in
      // the trip can be "missed", including a downstream transfer.
      const legs = [
        ...makeLegs(),
        {
          duration: 300,
          endTime: BOARD + 1200000,
          from: { lat: 44.825177, lon: -93.302367, name: 'City Hall' },
          mode: 'BUS',
          routeShortName: '539',
          startTime: BOARD + 900000,
          to: { lat: 44.84, lon: -93.29, name: 'Southdale TC' },
          transitLeg: true
        }
      ]
      expect(
        classifyMissedBus(
          baseInput({
            currentLegIndex: 2,
            legs,
            nowMs: BOARD + 1200000,
            riding: { legIndex: 1 }
          })
        )
      ).toBeNull()
    })

    it('riding un-anchored (legIndex -1) after an itinerary swap -> null', () => {
      expect(
        classifyMissedBus(
          baseInput({ nowMs: BOARD + 200000, riding: { legIndex: -1 } })
        )
      ).toBeNull()
    })

    it("planned trip's vehicle still bound for the boarding stop -> null (17:27 on 7/29)", () => {
      // The realtime epoch says "departed" but the bus's own fresh record is
      // still heading to the boarding stop — the epoch is stale, not the bus.
      expect(
        classifyMissedBus(
          baseInput({
            boardVehicle: {
              ageSec: 20,
              distanceToBoardStopM: null,
              nextStopId: '1:stop-queen'
            },
            liveLegTimes: { 1: { boardEpoch: BOARD, realtime: true } },
            nowMs: BOARD + 100000
          })
        )
      ).toBeNull()
    })

    it("planned trip's vehicle within the stop radius -> null", () => {
      expect(
        classifyMissedBus(
          baseInput({
            boardVehicle: {
              ageSec: 20,
              distanceToBoardStopM: 120,
              nextStopId: null
            },
            liveLegTimes: { 1: { boardEpoch: BOARD, realtime: true } },
            nowMs: BOARD + 100000
          })
        )
      ).toBeNull()
    })

    it('a stale vehicle record is not evidence — classification proceeds', () => {
      const ctx = classifyMissedBus(
        baseInput({
          boardVehicle: {
            ageSec: 300,
            distanceToBoardStopM: 111,
            nextStopId: '1:stop-queen'
          },
          liveLegTimes: { 1: { boardEpoch: BOARD, realtime: true } },
          nowMs: BOARD + 100000
        })
      )
      expect(ctx?.definitive).toBe(true)
      expect(ctx?.realtime).toBe(true)
    })

    it('strong vehicle match on the boarding leg -> null', () => {
      expect(
        classifyMissedBus(
          baseInput({
            currentLegIndex: 1,
            nowMs: BOARD + 200000,
            vehicleConfidence: 'high'
          })
        )
      ).toBeNull()
    })

    it('rider moving at vehicle speed -> null (assume boarded)', () => {
      expect(
        classifyMissedBus(
          baseInput({ nowMs: BOARD + 200000, riderSpeedMps: 12 })
        )
      ).toBeNull()
    })

    it('honors a rider-selected later departure', () => {
      const overrideMs = BOARD + 600000
      expect(
        classifyMissedBus(
          baseInput({ departureOverrideMs: overrideMs, nowMs: BOARD + 200000 })
        )
      ).toBeNull()
      const ctx = classifyMissedBus(
        baseInput({
          departureOverrideMs: overrideMs,
          nowMs: overrideMs + 200000,
          riderPosition: FAR_AWAY
        })
      )
      expect(ctx?.definitive).toBe(true)
      expect(ctx?.effectiveBoardMs).toBe(overrideMs)
    })

    it('no upcoming transit leg -> null', () => {
      expect(
        classifyMissedBus(
          baseInput({ currentLegIndex: 2, nowMs: BOARD + 900000 })
        )
      ).toBeNull()
    })
  })

  describe('checkMissedBus', () => {
    const legs = makeLegs()
    const ctxDefinitive = {
      boardLegIndex: 1,
      definitive: true,
      effectiveBoardMs: BOARD,
      realtime: true
    }

    it('builds the auto-update copy for a definitive miss', () => {
      const event = checkMissedBus(ctxDefinitive, legs, [])
      expect(event?.type).toBe('MISSED_BUS')
      expect(event?.priority).toBe('high')
      expect(event?.message).toContain('Missed the 546')
      expect(event?.message).toContain('next departure')
    })

    it('builds the checking-alternatives copy for an ambiguous miss', () => {
      const event = checkMissedBus(
        { ...ctxDefinitive, definitive: false },
        legs,
        []
      )
      expect(event?.message).toContain('may have left')
    })

    it('dedups per missed departure (30 min window)', () => {
      const sent = [
        `MISSED_BUS_546_${STOP.name}_${BOARD}_${Date.now() - 60000}`
      ]
      expect(checkMissedBus(ctxDefinitive, legs, sent)).toBeNull()
    })

    it('re-fires for a different departure epoch (the next bus missed too)', () => {
      const sent = [
        `MISSED_BUS_546_${STOP.name}_${BOARD}_${Date.now() - 60000}`
      ]
      const event = checkMissedBus(
        { ...ctxDefinitive, effectiveBoardMs: BOARD + 3600000 },
        legs,
        sent
      )
      expect(event).not.toBeNull()
    })
  })
})
