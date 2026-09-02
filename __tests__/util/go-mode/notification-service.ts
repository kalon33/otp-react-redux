import {
  BOARD_APPROACH_METRES,
  BOARD_ARRIVE_METRES,
  checkAlightAlerts,
  checkBoardVehicleApproach,
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
  itineraryArrivalMs,
  nextDeviationHandledAtMs,
  resetConnectionWarnings,
  resetDelayAlerts,
  resetLegAnnouncements,
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
  // The turn latch, the leg-entry latch, the connection-warning baseline and
  // the warned-lateness baseline all live for the life of a leg OBJECT; these
  // tests reuse a handful of leg literals across cases, so clear them between
  // them.
  beforeEach(() => {
    resetTurnAnnouncements()
    resetLegAnnouncements()
    resetConnectionWarnings()
    resetDelayAlerts()
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

      it('emits ONE card across a whole approach at riding speed', () => {
        const sent: string[] = []
        const stages: string[] = []
        // A bike closing on the corner at ~4 m/s, one tick per second. The
        // prepare lead is 120 m and the act lead 32 m, so the two cards would
        // land 22 s apart — under ACT_REMINDER_MIN_GAP_SECONDS, and exactly the
        // 12–28 s spacing that made five of ride 1's thirteen turn cards on
        // 2026-09-01 pure repetition.
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
        expect(stages).toEqual(['prepare'])
      })

      it('keeps the corner card for a rider slow enough to have forgotten', () => {
        // 2026-09-01 08:52:34 -> 08:54:16: the rider wheeled off the bus and
        // covered 102 m to the corner in 102 s. At 0.8 m/s the same two leads
        // are 112 s apart, which is a reminder rather than an echo.
        const sent: string[] = []
        const stages: string[] = []
        for (let distance = 200; distance >= 0; distance -= 4) {
          nowMs += 5000
          const event = checkUpcomingTurn(
            makeProgress({
              distanceToNextTurn: distance,
              nextTurnCue: makeCue(),
              riderSpeedMps: 0.8
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

    it('never pushes off-route while the matcher still says on-route', () => {
      // 2026-08-27, 13:14:02-04: the matcher held isOnRoute at 248m (its
      // transit corridor is 250m) while this check pushed "You are 239m from
      // the planned route". One question, two answers, 9m apart. The transit
      // threshold is now the matcher's own corridor.
      const busLeg = { mode: 'BUS' } as any
      expect(checkRouteDeviation(239, [], busLeg)).toBeNull()
      expect(checkRouteDeviation(250, [], busLeg)).toBeNull()
    })

    it('still flags a genuine deviation beyond the transit corridor', () => {
      const result = checkRouteDeviation(260, [], { mode: 'BUS' } as any)
      expect(result).not.toBeNull()
      expect(result!.type).toBe('ROUTE_DEVIATION')
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

  describe('checkBoardVehicleApproach', () => {
    // The rider's planned boarding: the 465 at I-35W & 98th St, with two more
    // stops before their exit. orderedStopsOnLeg = intermediates + alight (the
    // board stop is leg.from), so a vehicle nextStopId found on the leg means
    // the bus is already PAST the boarding.
    const boardLeg: any = {
      from: {
        lat: 44.865,
        lon: -93.3,
        name: 'I-35W & 98th St Station',
        stop: { gtfsId: '1:board-stop' }
      },
      intermediatePlaces: [
        {
          lat: 44.9,
          lon: -93.29,
          name: 'Mid stop',
          stop: { gtfsId: '1:mid-stop' }
        }
      ],
      mode: 'BUS',
      routeShortName: '465',
      to: {
        lat: 44.97,
        lon: -93.27,
        name: 'Downtown',
        stop: { gtfsId: '1:alight-stop' }
      },
      trip: { gtfsId: '1:trip-465' }
    }
    const NOW = 1787852667000
    const vehicle = (over: any = {}) => ({
      ageSec: 10,
      distanceToBoardStopM: 5000,
      nextStopId: null,
      ...over
    })
    const check = (vehicleOver: any, ctxOver: any = {}, sent: string[] = []) =>
      checkBoardVehicleApproach(
        boardLeg,
        {
          liveBoardEpochMs: null,
          nowMs: NOW,
          vehicle: vehicleOver === null ? null : vehicle(vehicleOver),
          ...ctxOver
        },
        sent
      )

    it('says nothing without a vehicle record — schedule times fire nothing', () => {
      expect(check(null)).toBeNull()
      expect(check(null, { liveBoardEpochMs: NOW + 60000 })).toBeNull()
    })

    it('says nothing on a stale record', () => {
      expect(
        check({ ageSec: 300, distanceToBoardStopM: BOARD_ARRIVE_METRES - 50 })
      ).toBeNull()
    })

    it('stays quiet while the bus is still far out with no live prediction', () => {
      expect(
        check({ distanceToBoardStopM: BOARD_APPROACH_METRES + 500 })
      ).toBeNull()
    })

    it('raises the heads-up when the bus closes on the stop', () => {
      const event = check({ distanceToBoardStopM: 1200 })
      expect(event).not.toBeNull()
      expect(event!.type).toBe('BOARD_BUS_APPROACHING')
      expect(event!.message).toContain('465')
      expect(event!.message).toContain('I-35W & 98th St Station')
    })

    it('raises the heads-up off a live board prediction inside the window', () => {
      const event = check(
        { distanceToBoardStopM: null },
        { liveBoardEpochMs: NOW + 120000 }
      )
      expect(event).not.toBeNull()
      expect(event!.type).toBe('BOARD_BUS_APPROACHING')
    })

    it('escalates to arriving at the stop — by next-stop fact or distance', () => {
      const byNextStop = check({ nextStopId: '1:board-stop' })
      expect(byNextStop!.type).toBe('BOARD_BUS_ARRIVING')
      expect(byNextStop!.priority).toBe('high')
      const byDistance = check({
        distanceToBoardStopM: BOARD_ARRIVE_METRES - 50
      })
      expect(byDistance!.type).toBe('BOARD_BUS_ARRIVING')
    })

    it('fires each stage exactly once across a full approach', () => {
      const sent: string[] = []
      const fired: string[] = []
      // 2.4km out to at-the-stop, 100m per tick.
      for (let d = 2400; d >= 0; d -= 100) {
        const event = check({ distanceToBoardStopM: d }, {}, sent)
        if (event) {
          fired.push(event.type)
          sent.push(event.id)
        }
      }
      expect(fired).toEqual(['BOARD_BUS_APPROACHING', 'BOARD_BUS_ARRIVING'])
    })

    it('says nothing about a bus already past the boarding stop', () => {
      // The vehicle's own next stop is beyond the boarding — been and gone.
      // MISSED_BUS owns that story; "your bus is arriving" would be a lie.
      expect(
        check({ distanceToBoardStopM: 200, nextStopId: '1:mid-stop' })
      ).toBeNull()
      expect(
        check({ distanceToBoardStopM: 200, nextStopId: '1:alight-stop' })
      ).toBeNull()
    })

    it('re-arms for a different run: the trip id is part of the key', () => {
      const first = check({ distanceToBoardStopM: 1200 })!
      // A re-plan onto a later run of the same route at the same stop.
      const laterRunLeg = { ...boardLeg, trip: { gtfsId: '1:trip-465-later' } }
      const again = checkBoardVehicleApproach(
        laterRunLeg,
        {
          liveBoardEpochMs: null,
          nowMs: NOW,
          vehicle: vehicle({ distanceToBoardStopM: 1200 })
        },
        [first.id]
      )
      expect(again).not.toBeNull()
      // While the SAME trip after an itinerary swap stays deduped.
      expect(
        checkBoardVehicleApproach(
          boardLeg,
          {
            liveBoardEpochMs: null,
            nowMs: NOW,
            vehicle: vehicle({ distanceToBoardStopM: 1200 })
          },
          [first.id]
        )
      ).toBeNull()
    })
  })

  describe('checkDelayAlert staleness', () => {
    // 2026-08-27: "94 is running about 3 min late" fired 64 seconds after the
    // rider stepped off the 94 at Rice Park. matchPositionToRoute only searches
    // forward, so between physically alighting and the leg transition firing,
    // the finished bus leg keeps accruing delay.
    const busLeg = {
      mode: 'BUS',
      routeShortName: '94',
      to: { name: 'Rice' }
    } as any
    const bikeLeg = { mode: 'BICYCLE', to: { name: 'Helmo' } } as any

    it('stays quiet about a leg the rider has already left', () => {
      expect(
        checkDelayAlert(
          makeProgress({ currentLegIndex: 3, delay: 240 }),
          busLeg,
          [],
          [bikeLeg, bikeLeg, busLeg, bikeLeg] // rider is on leg 3 now
        )
      ).toBeNull()
    })

    it('still alerts about the leg the rider IS on', () => {
      const alert = checkDelayAlert(
        makeProgress({
          currentLegIndex: 2,
          currentLegProgress: 40,
          delay: 240
        }),
        busLeg,
        [],
        [bikeLeg, bikeLeg, busLeg, bikeLeg]
      )
      expect(alert).not.toBeNull()
      expect(alert!.message).toContain('94')
    })

    it('stays quiet once the leg is essentially over', () => {
      expect(
        checkDelayAlert(
          makeProgress({
            currentLegIndex: 2,
            currentLegProgress: 99.5,
            delay: 240
          }),
          busLeg,
          [],
          [bikeLeg, bikeLeg, busLeg, bikeLeg]
        )
      ).toBeNull()
    })

    it('is unchanged when the caller supplies no legs', () => {
      expect(
        checkDelayAlert(
          makeProgress({ currentLegIndex: 2, delay: 240 }),
          busLeg,
          []
        )
      ).not.toBeNull()
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

    // 2026-08-27, Rice Park: the rider was warned FOUR times about the same
    // Gold Line connection — "about 56s", 102s, 120s, then 19s — and three of
    // those fired while the margin was IMPROVING as they closed on the stop.
    // Slack is recomputed every tick from progress.delay, which swings, and
    // nothing remembered what had already been said. The 120s dedup window is
    // exactly CONNECTION_SLACK_THRESHOLD_SECONDS, so it re-armed as fast as
    // the situation could change.
    it('warns once, then stays quiet while the margin recovers', () => {
      // Slack here = 300s - delay - 120s transfer. delay 240 -> 60s slack.
      const warn = checkConnectionWarning(
        makeProgress({ currentLegIndex: 0, delay: 240 }),
        connectionLegs,
        0,
        []
      )
      expect(warn).not.toBeNull()

      // Margin improving: 120s, then 150s of slack. Neither is news.
      expect(
        checkConnectionWarning(
          makeProgress({ currentLegIndex: 0, delay: 180 }),
          connectionLegs,
          0,
          []
        )
      ).toBeNull()
      expect(
        checkConnectionWarning(
          makeProgress({ currentLegIndex: 0, delay: 150 }),
          connectionLegs,
          0,
          []
        )
      ).toBeNull()
    })

    it('warns again once the margin genuinely deteriorates', () => {
      checkConnectionWarning(
        makeProgress({ currentLegIndex: 0, delay: 240 }), // 60s slack
        connectionLegs,
        0,
        []
      )
      // Down to 15s of slack — a real worsening, worth saying.
      const worse = checkConnectionWarning(
        makeProgress({ currentLegIndex: 0, delay: 285 }),
        connectionLegs,
        0,
        []
      )
      expect(worse).not.toBeNull()
      expect(worse!.type).toBe('CONNECTION_WARNING')
    })

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

    it('should not re-alert with the same number it just gave', () => {
      // The id carries the minutes the rider was READ, not the five-minute
      // bracket those minutes happened to fall in. Same number, nothing to say.
      const progress = makeProgress({ currentLegIndex: 0, delay: 240 })
      const recent = [`DELAY_ALERT_5_4_${Date.now() - 30000}`]
      expect(checkDelayAlert(progress, transitLeg, recent)).toBeNull()
    })

    it('should re-alert when lateness escalates', () => {
      // Previously alerted at 4 min; now 10 min late.
      const progress = makeProgress({ currentLegIndex: 0, delay: 600 })
      const recent = [`DELAY_ALERT_5_4_${Date.now() - 30000}`]
      const result = checkDelayAlert(progress, transitLeg, recent)
      expect(result).not.toBeNull()
      expect(result!.message).toContain('10 min late')
    })
  })

  describe('checkForNotifications', () => {
    // The off-by-one lived at the CALL SITE, not inside checkLegTransition —
    // every unit test above hands the announced leg straight in as the third
    // argument, so none of them could ever have caught it. On 2026-08-27 the
    // caller passed legs[i + 1] and the rider was told to board the wrong bus
    // at all three transitions: entering the bike leg -> "Board 94", entering
    // the 94 -> "Board METRO Gold Line", entering the Gold Line -> "Continue
    // to 4Front".
    it('announces the leg being ENTERED, not the one after it', () => {
      const enteredBike = {
        mode: 'BICYCLE',
        to: { name: '4th St S at 2nd Ave' }
      } as any
      const theBusAfterThat = {
        mode: 'BUS',
        routeShortName: '94',
        to: { name: 'Rice Park Station' }
      } as any

      const result = checkForNotifications(
        makeProgress({ currentLegIndex: 1 }),
        enteredBike,
        0, // previousLegIndex — a transition just happened
        theBusAfterThat,
        10,
        [],
        makeConfig()
      )

      const transition = result.find((n) => n.type === 'LEG_TRANSITION')
      expect(transition?.message).toBe('Continue to 4th St S at 2nd Ave')
      expect(transition?.message).not.toContain('94')
      expect(transition?.id).toContain('leg_1_BICYCLE')
    })

    it('names the bus the rider is actually boarding', () => {
      const enteredBus = {
        mode: 'BUS',
        routeShortName: '94',
        to: { name: 'Rice Park Station' }
      } as any
      const result = checkForNotifications(
        makeProgress({ currentLegIndex: 2 }),
        enteredBus,
        1,
        { mode: 'RAIL', routeShortName: 'Gold', to: { name: 'Helmo' } } as any,
        10,
        [],
        makeConfig()
      )
      const transition = result.find((n) => n.type === 'LEG_TRANSITION')
      expect(transition?.message).toBe('Board 94 to Rice Park Station')
      expect(transition?.message).not.toContain('Gold')
    })

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

/**
 * The 2026-09-01 notifier repeats — backlog 6.6 and 4.6, one defect in two
 * halves. Every timestamp and every string below is out of
 * otp-debug-logs/debug-2026-09-01.jsonl, session mtin0l9c-yieexg.
 *
 * The ride reports blamed the `Date.now()` suffix that generateNotificationId
 * appends to every id. It is innocent: wasRecentlySent strips the last
 * underscore-separated field before comparing prefixes, and the surviving keys
 * (`DELAY_ALERT_<route>_<bucket>`, `LEG_TRANSITION_leg_1_BUS`,
 * `ROUTE_DEVIATION_deviation`) matched perfectly. What re-fired was the WINDOW:
 * 300 s for the delay alert, 30 s for a leg entry, 120 s for a deviation, each
 * re-arming under a condition that had not changed. A window is a rate limit,
 * not a fact.
 */
describe('go-mode > the 2026-09-01 notification repeats', () => {
  let nowMs = 0
  let dateNowSpy: jest.SpyInstance

  beforeEach(() => {
    resetTurnAnnouncements()
    resetLegAnnouncements()
    resetConnectionWarnings()
    resetDelayAlerts()
    nowMs = 1788269138079 // 08:25:38.079, the first DELAY_ALERT of the ride
    dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs)
  })

  afterEach(() => {
    dateNowSpy.mockRestore()
  })

  describe('6.6 — DELAY_ALERT re-fires with the same number', () => {
    // Ride 1's five delay pushes, verbatim:
    //   08:25:38  "about 3 min late"   DELAY_ALERT_METRO Orange Line_0_…
    //   08:35:25  "about 3 min late"   (587 s later — the 300 s window aged out)
    //   08:41:05  "about 3 min late"   (340 s later — and again)
    //   08:45:19  "about 5 min late"
    //   08:50:20  "about 8 min late"
    const orangeLine = () =>
      ({
        mode: 'BUS',
        routeShortName: 'METRO Orange Line',
        to: { name: 'I-35W & Lake St Station' }
      } as any)

    const delayProgress = (delay: number) =>
      makeProgress({
        currentLegIndex: 0,
        currentLegProgress: 40,
        delay
      })

    it('says the same lateness once, however long the wait', () => {
      const leg = orangeLine()
      const sent: string[] = []

      const first = checkDelayAlert(delayProgress(190), leg, sent, [leg])
      expect(first).not.toBeNull()
      expect(first!.message).toContain('about 3 min late')
      sent.push(first!.id)

      // 08:35:25 — 587 s on, still ~3 min late. This is the push the rider got.
      nowMs = 1788269725152
      expect(checkDelayAlert(delayProgress(200), leg, sent, [leg])).toBeNull()

      // 08:41:05 — another 340 s, still ~3 min.
      nowMs = 1788270065135
      expect(checkDelayAlert(delayProgress(185), leg, sent, [leg])).toBeNull()
    })

    it('speaks again when the number the rider is read gets worse', () => {
      const leg = orangeLine()
      const sent: string[] = []

      const first = checkDelayAlert(delayProgress(190), leg, sent, [leg])
      sent.push(first!.id)

      // 08:45:19 — 5 min late. Two minutes worse than anything said so far.
      nowMs = 1788270319144
      const worse = checkDelayAlert(delayProgress(300), leg, sent, [leg])
      expect(worse).not.toBeNull()
      expect(worse!.message).toContain('about 5 min late')
      sent.push(worse!.id)

      // 08:50:20 — 8 min late.
      nowMs = 1788270620155
      const worst = checkDelayAlert(delayProgress(480), leg, sent, [leg])
      expect(worst).not.toBeNull()
      expect(worst!.message).toContain('about 8 min late')
    })

    it('does not chatter on a delay swinging a minute either way', () => {
      const leg = orangeLine()
      const sent: string[] = []
      const said: string[] = []
      // 3 -> 4 -> 3 -> 4 -> 3 min across twenty minutes of 1 Hz ticks.
      ;[190, 230, 200, 240, 195].forEach((delay) => {
        nowMs += 300000
        const event = checkDelayAlert(delayProgress(delay), leg, sent, [leg])
        if (event) {
          sent.push(event.id)
          said.push(event.message)
        }
      })
      expect(said).toHaveLength(1)
    })

    it('never quotes lateness at a rider who has arrived (4.15)', () => {
      // 2026-08-31 18:52: `delay` ran 1489 s -> 1911 s with the rider standing
      // still at their destination, because it is measured off the wall clock.
      const leg = orangeLine()
      expect(
        checkDelayAlert(
          makeProgress({
            currentLegIndex: 0,
            currentLegProgress: 40,
            delay: 1911,
            status: 'completed'
          }),
          leg,
          [],
          [leg]
        )
      ).toBeNull()

      // …and on the arrival tick itself, where `status` has not caught up but
      // the rider is demonstrably at the destination.
      expect(
        checkDelayAlert(
          makeProgress({
            currentLegIndex: 0,
            currentLegProgress: 40,
            delay: 1489,
            distanceToDestination: 12,
            overallProgress: 99.9
          }),
          leg,
          [],
          [leg]
        )
      ).toBeNull()
    })
  })

  describe('4.6 — the duplicate Board prompts', () => {
    // 10:37:35 -> 10:42:11, ELEVEN identical "Board METRO Orange Line to I-35W
    // & 98th St Station" cards, one every 30-32 s. The condition
    // `currentLegIndex > previousLegIndex` was true the whole time: the matcher
    // had projected the rider onto leg 1 while the board-time gate kept
    // refusing the transition, so `session.lastTransitionedLegIndex` stayed 0.
    const busLeg = () =>
      ({
        mode: 'BUS',
        routeShortName: 'METRO Orange Line',
        to: { name: 'I-35W & 98th St Station' }
      } as any)

    it('announces entering a leg once, not once per dedup window', () => {
      const leg = busLeg()
      const sent: string[] = []

      nowMs = 1788277053089 // 10:37:33.089
      const first = checkLegTransition(1, 0, leg, sent)
      expect(first).not.toBeNull()
      expect(first!.message).toBe(
        'Board METRO Orange Line to I-35W & 98th St Station'
      )
      sent.push(first!.id)

      // Every later fire from the real ride, at its real epoch. The condition
      // is still true at each one; the window is the only thing that changed.
      const repeats = [
        1788277084076, 1788277115078, 1788277145102, 1788277176073,
        1788277206095, 1788277237078, 1788277268079, 1788277298080,
        1788277329098
      ]
      repeats.forEach((atMs) => {
        nowMs = atMs
        expect(checkLegTransition(1, 0, leg, sent)).toBeNull()
      })
    })

    it('still guides a rider onto the leg an itinerary swap hands them', () => {
      // 10:48:52 START_GO_MODE, then the Board card 1.1 s later. A swap makes
      // new leg objects, and that is a genuinely new trip to be guided through.
      const sent: string[] = []
      const before = checkLegTransition(1, 0, busLeg(), sent)
      expect(before).not.toBeNull()
      sent.push(before!.id)

      nowMs = 1788277731073 // 10:48:51.073
      expect(checkLegTransition(1, 0, busLeg(), sent)).not.toBeNull()
    })
  })

  describe('4.5 — TRIP_UPDATED quotes the wrong arrival', () => {
    // The 08:26:27 push read "…to I-35W & Lake St Station, arriving 8:45 AM".
    // These are the two epochs off that tick's START_GO_MODE payload.
    const LEG0_END = 1788270304000 // 08:45:04 — when the rider gets OFF the bus
    const ITINERARY_END = 1788270705000 // 08:51:45 — when the trip ends

    it('names the trip end, not the bus leg end', () => {
      const spliced = {
        endTime: ITINERARY_END,
        legs: [
          { endTime: LEG0_END, mode: 'BUS' },
          { endTime: ITINERARY_END, mode: 'BICYCLE' }
        ]
      }
      expect(itineraryArrivalMs(spliced)).toBe(ITINERARY_END)
      expect(itineraryArrivalMs(spliced)).not.toBe(LEG0_END)
    })

    it('falls back to the last leg when the itinerary carries no end', () => {
      expect(
        itineraryArrivalMs({
          legs: [{ endTime: LEG0_END }, { endTime: ITINERARY_END }]
        })
      ).toBe(ITINERARY_END)
    })

    it('invents nothing when there is nothing to read', () => {
      expect(itineraryArrivalMs(undefined)).toBeNull()
      expect(itineraryArrivalMs({ legs: [] })).toBeNull()
    })
  })

  describe('4.6 — one Off Route card per deviation episode', () => {
    // 10:37:15, 10:39:15, 10:41:15, 10:43:15, 10:45:19 — five cards, 120 s
    // apart to the second, across ONE continuous excursion (663 -> 558 -> 749
    // -> 842 -> 750 m). checkRouteDeviation's cooldown was doing its job; it
    // was just measuring from the wrong event.
    const bikeLeg = { mode: 'BICYCLE', transitLeg: false } as any
    const FIRST_CARD = 1788277034074 // 10:37:14.074
    const SECOND_CARD = 1788277155077 // 10:39:15.077, 121.0 s later

    it('holds the clock while the rider is still off the line', () => {
      // The tick that pushed the first card.
      let handled = nextDeviationHandledAtMs({
        alerted: true,
        currentLeg: bikeLeg,
        distanceFromRoute: 663,
        handledAtMs: null,
        nowMs: FIRST_CARD,
        replanImminent: false
      })
      expect(handled).toBe(FIRST_CARD)

      // Every second in between, still hundreds of metres out and nothing said.
      for (let t = FIRST_CARD + 1000; t < SECOND_CARD; t += 1000) {
        handled = nextDeviationHandledAtMs({
          alerted: false,
          currentLeg: bikeLeg,
          distanceFromRoute: 600,
          handledAtMs: handled,
          nowMs: t,
          replanImminent: false
        })
      }

      // 10:39:15: the card that actually went out. With the clock held, the
      // cooldown has not aged a second and checkRouteDeviation stays quiet.
      expect(
        checkRouteDeviation(558, [], bikeLeg, {
          handledAtMs: handled,
          nowMs: SECOND_CARD
        })
      ).toBeNull()
    })

    it('speaks again for a rider who came back and left again', () => {
      // On route at 10:39:15 ends the episode; the stamp stops moving.
      const handled = nextDeviationHandledAtMs({
        alerted: false,
        currentLeg: bikeLeg,
        distanceFromRoute: 12,
        handledAtMs: FIRST_CARD,
        nowMs: SECOND_CARD,
        replanImminent: false
      })
      expect(handled).toBe(FIRST_CARD)

      // 120 s of floor later, a fresh excursion is fresh news.
      expect(
        checkRouteDeviation(240, [], bikeLeg, {
          handledAtMs: handled,
          nowMs: FIRST_CARD + 121000
        })
      ).not.toBeNull()
    })

    it('never opens a window that was closed — the first card still lands', () => {
      // A deviation nothing has spoken about yet: an itinerary swap 2 s ago is
      // holding the card back (DEVIATION_GEOMETRY_SETTLE_MS). Stamping here
      // would start a 120 s cooldown on a card that was never sent, and the
      // rider would never be told at all.
      const handled = nextDeviationHandledAtMs({
        alerted: false,
        currentLeg: bikeLeg,
        distanceFromRoute: 663,
        handledAtMs: null,
        nowMs: FIRST_CARD,
        replanImminent: false
      })
      expect(handled).toBeNull()

      // Stale from a previous episode, likewise left alone.
      expect(
        nextDeviationHandledAtMs({
          alerted: false,
          currentLeg: bikeLeg,
          distanceFromRoute: 663,
          handledAtMs: FIRST_CARD - 600000,
          nowMs: FIRST_CARD,
          replanImminent: false
        })
      ).toBe(FIRST_CARD - 600000)
    })

    it('counts a quiet re-plan as the deviation being handled, as before', () => {
      expect(
        nextDeviationHandledAtMs({
          alerted: false,
          currentLeg: bikeLeg,
          distanceFromRoute: 663,
          handledAtMs: null,
          nowMs: FIRST_CARD,
          replanImminent: true
        })
      ).toBe(FIRST_CARD)
    })
  })
})
