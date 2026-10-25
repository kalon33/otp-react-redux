/* globals describe, expect, it */
import fs from 'fs'
import path from 'path'

import coreUtils from '@opentripplanner/core-utils'

import {
  ARM_EXPIRY_MS,
  ARM_FIX_ACCURACY_MAX_M,
  ARM_LEAVE_RADIUS_M,
  ARM_MOTION_SUSTAIN_MS,
  armExpired,
  armFixOf,
  AUTO_ARM_STORAGE_KEY,
  destinationOf,
  loadArm,
  newArmWatch,
  pickArmedStart,
  saveArm,
  stepArmWatch
} from '../../../lib/util/go-mode/auto-arm'
import { haversineDistance } from '../../../lib/util/go-mode/geometry'
import type {
  ArmFix,
  ArmPoint,
  ArmTrigger,
  AutoArm
} from '../../../lib/util/go-mode/auto-arm'

/**
 * "Start when I leave" (backlog 65.2, cycle 36 B4): the trigger rules, the
 * 2 h lapse, the start pick — and the stationary-jitter pin, which runs the
 * trigger over every stretch of every recorded ride in which the rider stood
 * still and counts the stretches that would have started a trip.
 */

const HOME: [number, number] = [44.95, -93.29]
/** A point `m` metres north of HOME. */
const north = (m: number): [number, number] => [HOME[0] + m / 111195, HOME[1]]

const fixAt = (
  at: [number, number],
  tMs: number,
  extra: Partial<ArmFix> = {}
): ArmFix => ({
  accuracy: 8,
  lat: at[0],
  lon: at[1],
  speed: 0,
  tMs,
  ...extra
})

/** Run fixes through the watcher; the first trigger and when. */
function run(
  fixes: ArmFix[],
  point: ArmPoint | null = null
): { at: number | null; point: ArmPoint | null; why: ArmTrigger | null } {
  let watch = newArmWatch()
  let p = point
  for (const f of fixes) {
    const step = stepArmWatch(watch, p, f)
    watch = step.watch
    p = step.point
    if (step.trigger) return { at: f.tMs, point: p, why: step.trigger }
  }
  return { at: null, point: p, why: null }
}

describe('Start when I leave: the trigger (65.2 B4)', () => {
  it('takes the first good fix as the arm point and triggers nothing on it', () => {
    const r = run([
      fixAt(north(500), 0, { accuracy: 1414 }), // a cell fix: skipped
      fixAt(HOME, 1000),
      fixAt(HOME, 2000)
    ])
    expect(r.why).toBeNull()
    expect(r.point?.lat).toBeCloseTo(HOME[0], 6)
  })

  it('left: two fixes in a row past 75 m', () => {
    const r = run([
      fixAt(HOME, 0),
      fixAt(north(60), 20000),
      fixAt(north(80), 25000),
      fixAt(north(90), 30000)
    ])
    expect(ARM_LEAVE_RADIUS_M).toBe(75)
    expect(r).toMatchObject({ at: 30000, why: 'left' })
  })

  it('one fix out and back in is not leaving', () => {
    const r = run([
      fixAt(HOME, 0),
      fixAt(north(120), 5000), // a jump
      fixAt(north(10), 10000),
      fixAt(north(120), 15000),
      fixAt(north(5), 20000)
    ])
    expect(r.why).toBeNull()
  })

  it('a coarse fix neither counts nor breaks the run', () => {
    const r = run([
      fixAt(HOME, 0),
      fixAt(north(400), 5000, { accuracy: ARM_FIX_ACCURACY_MAX_M + 1 }),
      fixAt(north(400), 6000, { accuracy: 300 }),
      fixAt(north(90), 10000),
      fixAt(north(10), 12000, { accuracy: 120 }),
      fixAt(north(95), 15000)
    ])
    expect(r).toMatchObject({ at: 15000, why: 'left' })
  })

  it('moving: 1.5 m/s on every fix for 30 s, inside the radius', () => {
    const fixes = [fixAt(HOME, 0)]
    for (let s = 1; s <= 31; s++) {
      // 1.6 m/s reported, but pacing in a 20 m circle (never leaves)
      fixes.push(fixAt(north((s % 2) * 20), s * 1000, { speed: 1.6 }))
    }
    const r = run(fixes)
    expect(r.why).toBe('moving')
    // first fast fix at 1 s → 30 s sustained at 31 s
    expect(r.at).toBe(1000 + ARM_MOTION_SUSTAIN_MS)
  })

  it('29 s of motion then a stop is not leaving', () => {
    const fixes = [fixAt(HOME, 0)]
    for (let s = 1; s <= 29; s++) {
      fixes.push(fixAt(north(10), s * 1000, { speed: 2 }))
    }
    fixes.push(fixAt(north(10), 30000, { speed: 0.2 }))
    for (let s = 31; s <= 50; s++) {
      fixes.push(fixAt(north(10), s * 1000, { speed: 2 }))
    }
    expect(run(fixes).why).toBeNull()
  })

  it('no speed on the fix (the browser poll): derived over ≥ 3 s gaps', () => {
    // 2 m/s walking, polled every 5 s, speed null
    const fixes = [fixAt(HOME, 0, { speed: null })]
    for (let i = 1; i <= 8; i++) {
      fixes.push(fixAt(north(i * 10), i * 5000, { speed: null }))
    }
    const r = run(fixes)
    // 10 m / 5 s = 2 m/s from the 5 s fix; 30 s later = 35 s — but at 40 m
    // it has not left, so motion decides
    expect(r).toMatchObject({ at: 35000, why: 'moving' })
    // ...and pairs closer than 3 s are not trusted
    const close = [fixAt(HOME, 0, { speed: null })]
    for (let i = 1; i <= 40; i++) {
      close.push(fixAt(north((i % 2) * 6), i * 1000, { speed: null }))
    }
    expect(run(close).why).toBeNull()
  })

  it('a saved arm point carries over (a rider who left during a reload)', () => {
    const point: ArmPoint = { accuracy: 8, lat: HOME[0], lon: HOME[1], tMs: 0 }
    const r = run([fixAt(north(300), 60000), fixAt(north(310), 61000)], point)
    expect(r.why).toBe('left')
  })

  it('reads browser and native positions alike', () => {
    expect(
      armFixOf({
        coords: { accuracy: 5, latitude: 1, longitude: 2, speed: null },
        timestamp: 7
      })
    ).toEqual({ accuracy: 5, lat: 1, lon: 2, speed: null, tMs: 7 })
    expect(armFixOf({ coords: {} })).toBeNull()
  })
})

describe('Start when I leave: the 2 h lapse', () => {
  it('expires at two hours, not before', () => {
    const arm = { expiresAtMs: 1000 + ARM_EXPIRY_MS }
    expect(ARM_EXPIRY_MS).toBe(2 * 60 * 60 * 1000)
    expect(armExpired(arm, 1000 + ARM_EXPIRY_MS - 1)).toBe(false)
    expect(armExpired(arm, 1000 + ARM_EXPIRY_MS)).toBe(true)
    expect(armExpired(null, 0)).toBe(false)
  })

  const itin = (route: string, endTime: number): any => ({
    endTime,
    legs: [
      { from: { lat: 1, lon: 1 }, mode: 'WALK', to: { lat: 2, lon: 2 } },
      {
        from: { lat: 2, lon: 2 },
        mode: 'BUS',
        route: { id: route },
        to: { lat: 3, lon: 3, name: 'Home' },
        transitLeg: true
      }
    ],
    startTime: 0
  })
  const arm = (now: number): AutoArm => ({
    armedAtMs: now,
    expiresAtMs: now + ARM_EXPIRY_MS,
    id: 'arm-x',
    itinerary: itin('1:A', 5),
    point: null,
    preset: 'leastBike',
    status: 'starting',
    to: { lat: 3, lon: 3, name: 'Home' }
  })

  it('survives a reload until it lapses; a lapsed one is cleared', () => {
    const now = Date.now()
    saveArm(arm(now))
    const back = loadArm(now + ARM_EXPIRY_MS - 1)
    expect(back).toMatchObject({
      id: 'arm-x',
      preset: 'leastBike',
      // a start that died with the page is decided again
      status: 'armed'
    })
    expect(loadArm(now + ARM_EXPIRY_MS)).toBeNull()
    expect(coreUtils.storage.getItem(AUTO_ARM_STORAGE_KEY, null)).toBeNull()
    saveArm(null)
  })

  it('the destination is the plan’s last stop', () => {
    expect(destinationOf(itin('1:A', 5))).toEqual({
      lat: 3,
      lon: 3,
      name: 'Home'
    })
    expect(destinationOf({ legs: [] } as any)).toBeNull()
  })
})

describe('Start when I leave: what starts', () => {
  const MIN = 60000
  const plan = (route: string, arriveMin: number, bikeM = 0): any => ({
    endTime: arriveMin * MIN,
    legs: [
      {
        distance: bikeM || 100,
        endTime: 5 * MIN,
        from: { lat: 1, lon: 1 },
        mode: bikeM ? 'BICYCLE' : 'WALK',
        startTime: 0,
        to: { lat: 2, lon: 2 }
      },
      {
        endTime: arriveMin * MIN,
        from: { lat: 2, lon: 2 },
        mode: 'BUS',
        route: { id: route },
        startTime: 6 * MIN,
        to: { lat: 3, lon: 3 },
        transitLeg: true
      }
    ],
    startTime: 0
  })
  const armed = plan('1:A', 40)

  it('the armed route’s run, when nothing beats it', () => {
    const p = pickArmedStart(
      [plan('1:B', 39), plan('1:A', 41)],
      armed,
      'fastest'
    )
    expect(p.why).toBe('same-route')
    expect(p.itinerary?.legs[1].route.id).toBe('1:A')
  })

  it('a route the preset prefers by its own rule', () => {
    const p = pickArmedStart(
      [plan('1:A', 41), plan('1:B', 35)],
      armed,
      'fastest'
    )
    expect(p.why).toBe('preset')
    expect(p.itinerary?.legs[1].route.id).toBe('1:B')
  })

  it('Stay on my route never takes another route', () => {
    const answer = [plan('1:B', 20), plan('1:A', 41)]
    expect(pickArmedStart(answer, armed, 'stayOnRoute').itinerary).toBe(
      answer[1]
    )
    expect(pickArmedStart([plan('1:B', 20)], armed, 'stayOnRoute')).toEqual({
      itinerary: null,
      why: 'none'
    })
  })

  it('no armed route in the answer: its first plan is the bar', () => {
    const answer = [plan('1:C', 41), plan('1:B', 42)]
    expect(pickArmedStart(answer, armed, 'fastest')).toEqual({
      itinerary: answer[0],
      why: 'top'
    })
  })

  it('nothing usable: none (the caller starts the armed plan)', () => {
    expect(pickArmedStart([], armed, 'fastest').why).toBe('none')
    expect(pickArmedStart(null, armed, 'simplest').why).toBe('none')
  })
})

/* ------------------------------------------------------------------------ */
/* The stationary-jitter pin                                                */
/* ------------------------------------------------------------------------ */

const FIXTURES_DIR = path.join(
  __dirname,
  '../../../lib/util/go-mode/replay/fixtures'
)
const files = fs.existsSync(FIXTURES_DIR)
  ? fs
      .readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort()
  : []

interface TrackFix {
  accuracy?: number | null
  lat: number
  lon: number
  speed?: number | null
  tMs: number
}

/**
 * Where the rider stood still, judged WITHOUT the trigger: the position's
 * 20 s trailing median stays within STILL_RADIUS_M of where the stretch
 * began. The last STILL_TAIL_MS before it leaves are cut (the median lags
 * the first steps away). A ride's opening stretch counts from a minute; any
 * later one (a wait at a stop) from 150 s.
 */
const STILL_RADIUS_M = 30
const STILL_TAIL_MS = 30000
const MEDIAN_MS = 20000

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function smoothed(track: TrackFix[]): [number, number][] {
  return track.map((p, i) => {
    const w: TrackFix[] = []
    for (let j = i; j >= 0 && p.tMs - track[j].tMs <= MEDIAN_MS; j--) {
      w.push(track[j])
    }
    return [median(w.map((q) => q.lat)), median(w.map((q) => q.lon))]
  })
}

interface StillWindow {
  durationMs: number
  endMs: number
  fixes: TrackFix[]
  leading: boolean
  ride: string
  startMs: number
}

function stillWindows(ride: string, track: TrackFix[]): StillWindow[] {
  const sm = smoothed(track)
  const out: StillWindow[] = []
  let i = 0
  while (i < track.length) {
    let j = i
    while (
      j + 1 < track.length &&
      haversineDistance(sm[i], sm[j + 1]) <= STILL_RADIUS_M
    ) {
      j++
    }
    const durationMs = track[j].tMs - track[i].tMs
    const leading = i === 0
    if (durationMs >= (leading ? 60000 : 150000)) {
      const endMs = track[j].tMs - STILL_TAIL_MS
      out.push({
        durationMs,
        endMs,
        fixes: track.slice(i, j + 1).filter((p) => p.tMs <= endMs),
        leading,
        ride,
        startMs: track[i].tMs
      })
      i = j + 1
    } else {
      i++
    }
  }
  return out
}

const toArmFix = (p: TrackFix): ArmFix => ({
  accuracy: p.accuracy ?? null,
  lat: p.lat,
  lon: p.lon,
  speed: p.speed ?? null,
  tMs: p.tMs
})

/** The browser poll's view: every 5 s, no speed on the fix. */
function asBrowserPoll(fixes: ArmFix[]): ArmFix[] {
  const out: ArmFix[] = []
  let last = -Infinity
  for (const f of fixes) {
    if (f.tMs - last >= 5000) {
      out.push({ ...f, speed: null })
      last = f.tMs
    }
  }
  return out
}

const hm = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-GB', {
    hour12: false,
    timeZone: 'America/Chicago'
  })

describe('Start when I leave: stationary jitter over the recorded rides', () => {
  const windows: StillWindow[] = []
  for (const f of files) {
    let track: TrackFix[] = []
    try {
      const d = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8'))
      track = (d.gpsTrack || []).filter(
        (p: any) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon)
      )
    } catch {
      continue
    }
    if (track.length >= 5) windows.push(...stillWindows(f, track))
  }

  const falseStarts = (view: (fx: ArmFix[]) => ArmFix[], accuracyGate = true) =>
    windows
      .map((w) => {
        const fixes = view(w.fixes.map(toArmFix)).map((x) =>
          accuracyGate ? x : { ...x, accuracy: null }
        )
        const r = run(fixes)
        return r.why ? { at: r.at as number, w, why: r.why } : null
      })
      .filter(Boolean) as { at: number; w: StillWindow; why: ArmTrigger }[]

  it('no false start while the rider stood still', () => {
    const leading = windows.filter((w) => w.leading)
    const stillS = (ws: StillWindow[]) =>
      Math.round(ws.reduce((s, w) => s + (w.endMs - w.startMs), 0) / 1000)
    const native = falseStarts((x) => x)
    const browser = falseStarts(asBrowserPoll)
    const ungated = falseStarts((x) => x, false)
    // The measurement: printed, then pinned.
    // eslint-disable-next-line no-console
    console.log(
      [
        `[auto-arm jitter] ${files.length} fixtures; ` +
          `${leading.length} opening still stretches (${stillS(leading)} s), ` +
          `${windows.length - leading.length} later waits ≥150 s ` +
          `(${stillS(windows.filter((w) => !w.leading))} s)`,
        `  false starts, native fixes: ${native.length}` +
          `; browser poll (5 s, no speed): ${browser.length}` +
          `; without the ${ARM_FIX_ACCURACY_MAX_M} m accuracy gate: ${ungated.length}`,
        ...ungated.map(
          (u) =>
            `    ungated: ${u.w.ride} still from ${hm(u.w.startMs)} → ` +
            `${u.why} after ${Math.round((u.at - u.w.startMs) / 1000)} s`
        ),
        ...leading.map(
          (w) =>
            `  opening: ${w.ride} ${Math.round(
              (w.endMs - w.startMs) / 1000
            )} s still, ${w.fixes.length} fixes, worst accuracy ${Math.round(
              Math.max(...w.fixes.map((p) => p.accuracy ?? 0))
            )} m, farthest ${Math.round(
              Math.max(
                ...w.fixes.map((p) =>
                  haversineDistance(
                    [w.fixes[0].lat, w.fixes[0].lon],
                    [p.lat, p.lon]
                  )
                )
              )
            )} m from the first fix`
        )
      ].join('\n')
    )
    expect(native).toEqual([])
    expect(browser).toEqual([])
  })

  it('the accuracy gate is what holds the 1,414 m cell fix (ride-0930-1608)', () => {
    if (!files.includes('ride-0930-1608.json')) return
    const ungated = falseStarts((x) => x, false).map((u) => u.w.ride)
    expect(ungated).toContain('ride-0930-1608.json')
  })

  it('synthetic: two hours at home with 35 m-accuracy drift starts nothing', () => {
    // GPS error drifts rather than jumps: an AR(1) wander around HOME of
    // about ±20 m, a fix a second, a small reported speed.
    let seed = 7
    const rnd = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647 - 0.5
    }
    let dx = 0
    let dy = 0
    const fixes: ArmFix[] = []
    for (let s = 0; s < 7200; s++) {
      dx = 0.97 * dx + rnd() * 6
      dy = 0.97 * dy + rnd() * 6
      fixes.push({
        accuracy: 35,
        lat: HOME[0] + dy / 111195,
        lon: HOME[1] + dx / 78700,
        speed: Math.abs(rnd()) * 1.2,
        tMs: s * 1000
      })
    }
    const far = Math.max(
      ...fixes.map((f) => haversineDistance(HOME, [f.lat, f.lon]))
    )
    expect(far).toBeGreaterThan(15)
    expect(run(fixes).why).toBeNull()
    expect(run(asBrowserPoll(fixes)).why).toBeNull()
  })
})
