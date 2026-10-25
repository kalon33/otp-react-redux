/* globals afterAll, beforeAll, describe, expect, it, jest */
import fs from 'fs'
import path from 'path'

import {
  AUTO_LATER_ALLOWANCE_MS,
  AUTO_PRESETS,
  autoPresetVerdict,
  changesOf,
  rankAlightForPreset
} from '../../../lib/util/go-mode/auto-priority'
import {
  bikeMetersOf,
  bikeSpeedOf,
  classifyFasterRoute,
  compareAlightOffer,
  EMPTY_FASTER_ROUTE_LATCH,
  FASTER_ROUTE_MIN_SAVING_MS,
  findBaseline,
  latchAllows,
  latchRecordOffer,
  plannedOnwardOf,
  remainingTransitLegs,
  routeSetOf
} from '../../../lib/util/go-mode/faster-route'
import { calculateDistance } from '../../../lib/util/go-mode/position-matching'
import { legTripId } from '../../../lib/util/go-mode/leg-merge'
import type { AutoPreset } from '../../../lib/util/go-mode/auto-priority'
import type {
  FasterRouteLatch,
  FasterRouteVerdict
} from '../../../lib/util/go-mode/faster-route'

/**
 * Backlog 56.1, cycle 25 B1 — MEASURE FIRST.
 *
 * Replays every recorded fixture's background answers (`rerouteSnapshots`,
 * the recorder's isolated plan() from the rider's position) through
 * classifyFasterRoute, and every onboard optimizer answer
 * (`onboardCandidatePlans`) through compareAlightOffer, and PRINTS what the
 * offer would have done: each ≥3-min different-route hit with its class, the
 * offers per ride after the latch, and the aboard comparator. Only the pins
 * are asserted; the printout is the measurement.
 *
 * Fixtures not committed to the repo are skipped where absent (the house
 * convention); on rwtpc4 the full set of recorded rides is present.
 */

jest.setTimeout(900000)

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

const hm = (ms: number | null | undefined, tz = 'America/Chicago'): string =>
  ms == null || !Number.isFinite(ms)
    ? '—'
    : new Date(ms).toLocaleTimeString('en-GB', { hour12: false, timeZone: tz })
const min = (ms: number) => (ms / 60000).toFixed(1)

interface Hit {
  aboardByTime: boolean
  actualArrival: number | null
  baseMinusHeldMs: number
  candRoutes: string
  cls: string
  extra: string
  ride: string
  savingMs: number
  source: string | null
  t: number
  verdict: FasterRouteVerdict
}

interface RideOffers {
  offers: {
    bikeSavedM: number
    kind: string
    routeSet: string
    savingMs: number
    t: number
  }[]
  ride: string
  suppressed: number
}

const hits: Hit[] = []
const rideOffers: RideOffers[] = []
const aboardRows: string[] = []
const lines: string[] = []
const totals = {
  aboardByTime: 0,
  answers: 0,
  lostAtResponsePosition: 0,
  ownNextTrip: 0,
  ownTrips: 0,
  rawHits: 0,
  transitLeft: 0,
  whys: {} as Record<string, number>
}
const pinVerdicts: Record<string, { t: number; v: FasterRouteVerdict }[]> = {}
const pinOffBusForced: Record<string, number> = {}
const pinAboard: Record<string, number> = {}

/* 65.2 B1 — the Auto sweep: every off-bus answer through each preset. */
const ALLOWANCES = [AUTO_LATER_ALLOWANCE_MS, 300000]
interface AutoSwitch {
  allowanceMs: number
  bikeSavedM: number
  changesFewer: number
  /** Simulated with two-answer confirmation (switch only on the 2nd pick). */
  confirm: boolean
  endMs: number
  hindsight: number
  hindsightSrc: string
  preset: AutoPreset
  /** Back to a route set this ride already held. */
  reversal: boolean
  ride: string
  routeSet: string
  savingMs: number
  t: number
}
const autoSwitches: AutoSwitch[] = []
const autoPins = {
  aboardFastestDiff: 0,
  aboardStay: 0,
  aboardSwitches: {} as Record<string, number>,
  fastestDiff: [] as string[],
  fastestTiesBroken: 0,
  leastBikeMoreBike: 0,
  offBusAnswers: 0,
  simplestFewer: 0,
  simplestFewerAvailable: 0,
  simplestMoreChanges: 0,
  stayRouteSwitches: 0
}

const itinsOf = (resp: any): any[] => resp?.data?.plan?.itineraries || []

function heldAt(fx: any, t: number): any {
  let held = fx.itinerary
  const swaps = [...(fx.itinerarySwaps || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  for (const s of swaps) if (s.tMs <= t) held = s.itinerary
  return held
}

function fixAt(track: any[], t: number): any {
  let lo = 0
  let hi = track.length - 1
  let best = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (track[mid].tMs <= t) {
      best = track[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

/** First GPS fix within 150 m of the destination — when the record reaches it. */
function actualArrivalOf(fx: any, track: any[]): number | null {
  const legs = fx.itinerary?.legs || []
  const dest = legs[legs.length - 1]?.to
  if (!dest) return null
  const at = track.find(
    (f) => calculateDistance(f.lat, f.lon, dest.lat, dest.lon) <= 150
  )
  return at ? at.tMs : null
}

function classOf(v: FasterRouteVerdict, baseMinusHeldMs: number): string {
  if (v.why === 'plan-dead') return `plan dead (${v.planDead})`
  if (v.why === 'not-catchable')
    return `not catchable (${v.rejected.join(',')})`
  if (v.why === 'same-bus')
    return 'baseline artifact (same bus, different tail)'
  if (v.why === 'not-better') {
    return v.baselineSource === 'own-route-earlier-run'
      ? 'own route has an earlier run'
      : 'baseline artifact (bike pace)'
  }
  if (v.why === 'offer') {
    if (v.baselineSource === 'own-next-trip')
      return 'baseline artifact (own-next-trip)'
    if (v.baselineSource === 'own-route-earlier-run')
      return 'real (vs earlier own run)'
    return 'real'
  }
  return v.why
}

function measureFixture(file: string): void {
  const ride = file.replace(/\.json$/, '')
  const fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8'))
  const track = [...(fx.gpsTrack || [])].sort((a: any, b: any) => a.tMs - b.tMs)
  const actual = actualArrivalOf(fx, track)
  // The plan's own bike pace (the card's), from the itinerary the rider chose.
  const refMps = bikeSpeedOf(fx.itinerary)
  // Hindsight: when the rider really got there — the GPS arrival when the
  // record reaches the door, else the last plan they were on (its arrival).
  const lastPlan = heldAt(fx, Infinity)
  const hindsight = actual ?? Number(lastPlan?.endTime)
  const hindsightSrc = actual ? 'gps' : 'last plan'
  const snaps = [...(fx.rerouteSnapshots || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  let latch: FasterRouteLatch = EMPTY_FASTER_ROUTE_LATCH
  const offers: RideOffers['offers'] = []
  let suppressed = 0
  for (const snap of snaps) {
    const t = snap.tMs
    const held = heldAt(fx, t)
    const answer = itinsOf(snap.response)
    totals.answers++
    const remaining = remainingTransitLegs(held, t)
    if (!remaining.length) continue
    totals.transitLeft++
    const aboard = Number(remaining[0].startTime) <= t
    if (aboard) totals.aboardByTime++
    const from = snap.request?.from
    const fix =
      track.find((f) => f.lat === from?.lat && f.lon === from?.lon) ||
      fixAt(track, t)
    const fixAtResponse = fixAt(track, t)
    const input = {
      answer,
      current: held,
      headingDeg: fix?.heading ?? null,
      nowMs: t,
      position: fix ? ([fix.lat, fix.lon] as [number, number]) : null,
      referenceBikeSpeedMps: refMps,
      riding: aboard,
      speedMps: fix?.speed ?? null
    }
    const v = classifyFasterRoute(input)
    totals.whys[v.why] = (totals.whys[v.why] || 0) + 1
    if (v.kind && fixAtResponse && fixAtResponse !== fix) {
      // Same answer, judged at the position the rider has reached when it
      // lands (~3-12 s later) — B2's latency hazard.
      const late = classifyFasterRoute({
        ...input,
        headingDeg: fixAtResponse.heading ?? null,
        position: [fixAtResponse.lat, fixAtResponse.lon],
        speedMps: fixAtResponse.speed ?? null
      })
      if (!late.kind) totals.lostAtResponsePosition++
    }
    if (pinVerdicts[ride]) pinVerdicts[ride].push({ t, v })
    if (!aboard) {
      autoPins.offBusAnswers++
      for (const allowanceMs of ALLOWANCES) {
        for (const preset of AUTO_PRESETS) {
          if (allowanceMs !== AUTO_LATER_ALLOWANCE_MS && preset === 'fastest')
            continue
          if (
            allowanceMs !== AUTO_LATER_ALLOWANCE_MS &&
            preset === 'stayOnRoute'
          )
            continue
          const a = autoPresetVerdict(input, preset, { allowanceMs })
          const bar = a.pool?.bar
          if (allowanceMs === AUTO_LATER_ALLOWANCE_MS) {
            if (preset === 'fastest') {
              const same =
                (a.pick?.itinerary ?? null) === (v.kind ? v.candidate : null)
              if (!same) autoPins.fastestDiff.push(`${ride} ${hm(t)}`)
              if (
                a.ranked.length > 1 &&
                a.ranked[1].savingMs === a.ranked[0].savingMs
              )
                autoPins.fastestTiesBroken++
            }
            if (preset === 'stayOnRoute' && a.pick) autoPins.stayRouteSwitches++
            if (
              preset === 'leastBike' &&
              a.pick &&
              bar &&
              a.pick.bikeSavedM < 0
            )
              autoPins.leastBikeMoreBike++
            if (preset === 'simplest' && bar) {
              if (a.pick && a.pick.changes > changesOf(bar))
                autoPins.simplestMoreChanges++
              if (a.pick && a.pick.changes < changesOf(bar))
                autoPins.simplestFewer++
              const pool = a.pool
              if (
                pool &&
                pool.others.some((it: any) => changesOf(it) < changesOf(bar))
              )
                autoPins.simplestFewerAvailable++
            }
          }
        }
      }
    }
    // The aboard pin: the same answer judged as if off the bus.
    if (aboard && ride === 'orange-1639-1017') {
      const off = classifyFasterRoute({ ...input, riding: false })
      if (off.kind) pinOffBusForced[ride] = (pinOffBusForced[ride] || 0) + 1
    }

    // Raw hit (the plan's count): rider's exact own trips in the same answer,
    // best different-route-set itinerary ≥ 3 min earlier — before any rule.
    const found = findBaseline(answer, remaining)
    if (found?.source === 'own-trips') totals.ownTrips++
    if (found?.source === 'own-next-trip') totals.ownNextTrip++
    if (found?.source === 'own-trips') {
      const heldSet = routeSetOf({ legs: remaining } as any)
      const others = answer.filter((it: any) => routeSetOf(it) !== heldSet)
      const best = others.reduce(
        (m: any, it: any) => (!m || it.endTime < m.endTime ? it : m),
        null
      )
      const saving = best ? found.itinerary.endTime - best.endTime : -Infinity
      if (saving >= FASTER_ROUTE_MIN_SAVING_MS) {
        totals.rawHits++
        // judge as if off the bus, so an aboard hit is classified too
        const off = aboard
          ? classifyFasterRoute({ ...input, riding: false })
          : v
        const baseMinusHeldMs = found.itinerary.endTime - held.endTime
        const sameSet = answer.filter((it: any) => routeSetOf(it) === heldSet)
        const bestSame = sameSet.reduce(
          (m: number, it: any) => Math.min(m, it.endTime),
          Infinity
        )
        const ownNext = legTripId(remaining[0])
        hits.push({
          aboardByTime: aboard,
          actualArrival: actual,
          baseMinusHeldMs,
          candRoutes: routeSetOf(best) || 'bike',
          cls: (aboard ? 'aboard; ' : '') + classOf(off, baseMinusHeldMs),
          extra:
            `hindsight=${hm(hindsight)}(${hindsightSrc})` +
            (off.kind && off.candidate
              ? ` offerArr=${hm(
                  Number(off.candidate.endTime)
                )} vsHindsight=${min(
                  hindsight - Number(off.candidate.endTime)
                )}m`
              : '') +
            ` q=${Number(snap.request?.variables?.bikeSpeed || 0).toFixed(2)}` +
            `/ref=${(refMps || 0).toFixed(2)}m/s` +
            (found.itinerary.endTime - bestSame >= 60000
              ? ` ownRouteEarlierRun=${min(
                  found.itinerary.endTime - bestSame
                )}m`
              : '') +
            ((best.legs || []).some(
              (l: any) => l.transitLeg && legTripId(l) === ownNext
            )
              ? ' candRidesOwnBus'
              : ''),
          ride,
          savingMs: saving,
          source: found.source,
          t,
          verdict: off
        })
      }
    }

    if (v.kind && v.candidate && v.routeSet != null) {
      const key = {
        bikeSavedM: v.bikeSavedM,
        kind: v.kind,
        routeSet: v.routeSet,
        savingMs: v.savingMs
      }
      const gate = latchAllows(latch, key)
      if (gate.allow) {
        latch = latchRecordOffer(latch, key, gate.push)
        offers.push({ t, ...key })
      } else suppressed++
    }
  }
  // 65.2 B1: Auto per preset, simulated — once Auto switches, the held plan
  // IS the switched itinerary, and later answers are judged against it.
  for (const confirm of [false, true]) {
    for (const allowanceMs of ALLOWANCES) {
      for (const preset of AUTO_PRESETS) {
        if (
          allowanceMs !== AUTO_LATER_ALLOWANCE_MS &&
          (preset === 'fastest' || preset === 'stayOnRoute')
        )
          continue
        let simHeld: any = null
        const heldSets: string[] = [routeSetOf(heldAt(fx, -Infinity))]
        let pending: string | null = null
        for (const snap of snaps) {
          const t = snap.tMs
          const held = simHeld ?? heldAt(fx, t)
          const remaining = remainingTransitLegs(held, t)
          if (!remaining.length) continue
          const from = snap.request?.from
          const fix =
            track.find((f) => f.lat === from?.lat && f.lon === from?.lon) ||
            fixAt(track, t)
          const a = autoPresetVerdict(
            {
              answer: itinsOf(snap.response),
              current: held,
              headingDeg: fix?.heading ?? null,
              nowMs: t,
              position: fix ? ([fix.lat, fix.lon] as [number, number]) : null,
              referenceBikeSpeedMps: refMps,
              riding: Number(remaining[0].startTime) <= t,
              speedMps: fix?.speed ?? null
            },
            preset,
            { allowanceMs }
          )
          const bar = a.pool?.bar
          if (!a.pick || !bar) {
            pending = null
            continue
          }
          const routeSet = routeSetOf(a.pick.itinerary) || 'bike'
          if (confirm && pending !== routeSet) {
            pending = routeSet
            continue
          }
          pending = null
          autoSwitches.push({
            allowanceMs,
            bikeSavedM: Math.round(a.pick.bikeSavedM),
            changesFewer: changesOf(bar) - a.pick.changes,
            confirm,
            endMs: Number(a.pick.itinerary.endTime),
            hindsight,
            hindsightSrc,
            preset,
            reversal: heldSets.includes(routeSet),
            ride,
            routeSet,
            savingMs: a.pick.savingMs,
            t
          })
          heldSets.push(routeSet)
          simHeld = a.pick.itinerary
        }
      }
    }
  }
  if (offers.length || suppressed) rideOffers.push({ offers, ride, suppressed })

  // Aboard: onboard optimizer answers, batched by run.
  const ocp = [...(fx.onboardCandidatePlans || [])].sort(
    (a: any, b: any) => a.tMs - b.tMs
  )
  const batches: any[][] = []
  for (const rec of ocp) {
    const last = batches[batches.length - 1]
    if (last && rec.tMs - last[last.length - 1].tMs <= 30000) last.push(rec)
    else batches.push([rec])
  }
  for (const batch of batches) {
    const t = batch[0].tMs
    const held = heldAt(fx, t)
    const stopIds = new Set(batch.map((r: any) => r.stopId))
    const legs = held.legs || []
    // The leg the rider is aboard: the transit leg whose alight is one of the
    // candidate stops, else the one in progress by time.
    let i = legs.findIndex(
      (l: any) => l.transitLeg && stopIds.has(l.to?.stop?.gtfsId)
    )
    if (i < 0) {
      i = legs.findIndex(
        (l: any) => l.transitLeg && l.startTime <= t && l.endTime > t
      )
    }
    const results = batch.map((r: any) => ({
      busArrivalEpoch: r.request?.busArrivalEpoch,
      itineraries: itinsOf(r.response),
      realtime: true,
      stopId: r.stopId,
      stopName: r.request?.from?.name || r.stopId
    }))
    if (i < 0) {
      aboardRows.push(`${ride} ${hm(t)} — no aboard leg in the held plan`)
      continue
    }
    const plannedStopId = legs[i].to?.stop?.gtfsId
    const onward = legs.slice(i + 1).find((l: any) => l.transitLeg)
    // As the caller asks (56.1 re-build): the onward leg as the card shows it.
    const v = compareAlightOffer({
      nowMs: t,
      plannedOnward: plannedOnwardOf(held, i, null),
      plannedOnwardTripId: onward ? legTripId(onward) : null,
      plannedStopId,
      results
    })
    // ...and the trip-id-only baseline it replaced, printed where it differs.
    const byId = compareAlightOffer({
      nowMs: t,
      plannedOnwardTripId: onward ? legTripId(onward) : null,
      plannedStopId,
      results
    })
    const differs =
      byId.why !== v.why ||
      byId.kind !== v.kind ||
      byId.baselineArrival !== v.baselineArrival
    if (v.kind) pinAboard[ride] = (pinAboard[ride] || 0) + 1
    for (const preset of AUTO_PRESETS) {
      const a = rankAlightForPreset(
        {
          nowMs: t,
          plannedOnward: plannedOnwardOf(held, i, null),
          plannedOnwardTripId: onward ? legTripId(onward) : null,
          plannedStopId,
          results
        },
        preset
      )
      if (preset === 'fastest' && !!a.pick !== !!v.kind)
        autoPins.aboardFastestDiff++
      if (a.pick) {
        autoPins.aboardSwitches[preset] =
          (autoPins.aboardSwitches[preset] || 0) + 1
        if (preset === 'stayOnRoute') autoPins.aboardStay++
        aboardRows.push(
          `  auto ${preset}: ${a.pick.option.stopName} [${
            routeSetOf(a.pick.option.itinerary) || 'bike'
          }] saving=${min(a.pick.savingMs)}m bike-${Math.round(
            a.pick.bikeSavedM
          )}m changes=${a.pick.changes}`
        )
      }
    }
    aboardRows.push(
      `${ride.padEnd(32)} ${hm(t)} stops=${
        results.length
      } planned=${plannedStopId}` +
        ` → ${v.why}${v.kind ? `:${v.kind}` : ''}` +
        (v.baselineArrival != null
          ? ` base=${hm(v.baselineArrival)} top=${hm(v.candidateArrival)}@${
              v.candidate?.stopName
            } [${routeSetOf(v.candidate?.itinerary) || 'bike'}] saving=${min(
              v.savingMs
            )}m bike-${v.bikeSavedM}m`
          : '') +
        (differs
          ? ` [trip-id-only: ${byId.why}${
              byId.kind ? `:${byId.kind}` : ''
            } base=${hm(byId.baselineArrival)} saving=${min(byId.savingMs)}m]`
          : '')
    )
  }
}

const PINS = [
  'orange-1639-1017',
  'orange-1728-ride2',
  'orange-1008-1601',
  'helmo-goldline-1027',
  'h5he2i-0931-two-early-buses',
  'ride-0930-1648'
]

beforeAll(() => {
  PINS.forEach((p) => (pinVerdicts[p] = []))
  files.forEach(measureFixture)
})

afterAll(() => {
  if (!files.length) return
  lines.push('', '=== 56.1 faster-route measurement ===')
  lines.push(
    `fixtures=${files.length} answers=${totals.answers} transitLeft=${totals.transitLeft}` +
      ` aboardByTime=${totals.aboardByTime} ownTrips=${totals.ownTrips}` +
      ` ownNextTripOnly=${totals.ownNextTrip} rawHits(≥3min,own-trips)=${totals.rawHits}`
  )
  lines.push(`classifier outcomes: ${JSON.stringify(totals.whys)}`)
  lines.push(
    `offers lost if judged at the response-time fix instead of the request fix: ${totals.lostAtResponsePosition}`
  )
  lines.push(
    '',
    '--- ≥3-min different-route hits (ride, time, saving, class) ---'
  )
  const byClass: Record<string, number> = {}
  for (const h of hits) {
    const key = h.cls.replace(/ \(.*\)$/, '').replace(/^aboard; /, 'aboard; ')
    byClass[key] = (byClass[key] || 0) + 1
    lines.push(
      `${h.ride.padEnd(30)} ${hm(h.t)} saving=${min(h.savingMs).padStart(5)}m` +
        ` via ${h.candRoutes.padEnd(14)} base-held=${min(
          h.baseMinusHeldMs
        ).padStart(5)}m` +
        ` ${h.extra} → ${h.cls}` +
        (h.verdict.kind
          ? ` (offer ${h.verdict.kind} ${min(h.verdict.savingMs)}m)`
          : '')
    )
  }
  lines.push(`hit classes: ${JSON.stringify(byClass)}`)
  lines.push('', '--- offers per ride after the latch ---')
  let total = 0
  for (const r of rideOffers) {
    total += r.offers.length
    lines.push(
      `${r.ride.padEnd(30)} offers=${r.offers.length} suppressed=${
        r.suppressed
      } ` +
        r.offers
          .map(
            (o) =>
              `[${hm(o.t)} ${o.kind} ${min(o.savingMs)}m bike-${Math.round(
                o.bikeSavedM
              )}m via ${o.routeSet || 'bike'}]`
          )
          .join(' ')
    )
  }
  lines.push(
    `total offers=${total} on ${
      rideOffers.filter((r) => r.offers.length).length
    } rides`
  )
  lines.push('', '--- aboard comparator (onboardCandidatePlans) ---')
  aboardRows.forEach((r) => lines.push(r))
  lines.push('', '--- pins ---')
  for (const p of PINS) {
    const vs = pinVerdicts[p] || []
    lines.push(
      `${p}: ${vs.length} answers; ` +
        vs
          .filter((x) => x.v.why !== 'no-transit-left')
          .map(
            (x) =>
              `${hm(x.t)} ${x.v.why}${x.v.kind ? ':' + x.v.kind : ''}${
                x.v.planDead ? '(' + x.v.planDead + ')' : ''
              }${
                x.v.bestRawSavingMs != null
                  ? ' raw=' + min(x.v.bestRawSavingMs) + 'm'
                  : ''
              }${
                x.v.kind
                  ? ' saving=' +
                    min(x.v.savingMs) +
                    'm bike-' +
                    x.v.bikeSavedM +
                    'm'
                  : ''
              }`
          )
          .join('; ')
    )
  }
  lines.push('', '=== 65.2 Auto preset sweep (off-bus answers) ===')
  lines.push(
    `off-bus answers=${autoPins.offBusAnswers}` +
      ` fastest≢56.1=${autoPins.fastestDiff.length}` +
      ` fastestExactSavingTies=${autoPins.fastestTiesBroken}` +
      ` stayRouteSwitches=${autoPins.stayRouteSwitches}` +
      ` leastBikeMoreBike=${autoPins.leastBikeMoreBike}` +
      ` simplestMoreChanges=${autoPins.simplestMoreChanges}` +
      ` simplestFewerPicked=${autoPins.simplestFewer}` +
      ` answersWithAFewerChangeItinerary=${autoPins.simplestFewerAvailable}`
  )
  lines.push(
    `aboard: fastest≢compareAlightOffer=${
      autoPins.aboardFastestDiff
    } switches=${JSON.stringify(autoPins.aboardSwitches)}`
  )
  for (const allowanceMs of ALLOWANCES) {
    for (const preset of AUTO_PRESETS) {
      const sw = autoSwitches.filter(
        (x) =>
          x.preset === preset && x.allowanceMs === allowanceMs && !x.confirm
      )
      const confirmed = autoSwitches.filter(
        (x) => x.preset === preset && x.allowanceMs === allowanceMs && x.confirm
      )
      if (allowanceMs !== AUTO_LATER_ALLOWANCE_MS && !sw.length) continue
      const rides = Array.from(new Set(sw.map((x) => x.ride)))
      const perRide = rides.map(
        (r) => `${r}:${sw.filter((x) => x.ride === r).length}`
      )
      const ridesWithSnaps = files.length
      lines.push(
        '',
        `--- ${preset} (allowance ${min(allowanceMs)}m, simulated): ${
          sw.length
        } switches on ${rides.length} rides (${(
          sw.length / Math.max(1, ridesWithSnaps)
        ).toFixed(2)}/fixture, max ${Math.max(
          0,
          ...rides.map((r) => sw.filter((x) => x.ride === r).length)
        )}/ride), ${
          sw.filter((x) => x.reversal).length
        } reversals; with 2-answer confirmation: ${
          confirmed.length
        } switches on ${new Set(confirmed.map((x) => x.ride)).size} rides, ${
          confirmed.filter((x) => x.reversal).length
        } reversals ---`
      )
      lines.push(`  switches per ride: ${perRide.join(' ')}`)
      for (const x of sw) {
        const vs = x.hindsight - x.endMs
        // Wrong by hindsight: the switch lands later than the rider really
        // got there by more than the preset accepts — Fastest: beyond the
        // rider's own ±2 min "same arrival"; the others: their allowance.
        const limit = preset === 'fastest' ? 120000 : x.allowanceMs
        const wrong = vs < -limit
        lines.push(
          `  ${x.ride.padEnd(30)} ${hm(x.t)} → ${x.routeSet.padEnd(
            14
          )} saving=${min(x.savingMs).padStart(5)}m bike-${
            x.bikeSavedM
          }m changes-${x.changesFewer} arr=${hm(x.endMs)} hindsight=${hm(
            x.hindsight
          )}(${x.hindsightSrc}) vs=${min(vs)}m${
            wrong
              ? x.hindsightSrc === 'gps'
                ? ' WRONG'
                : ' wrong?(last plan)'
              : ''
          }${x.reversal ? ' REVERSAL' : ''}`
        )
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'))
})

describe('util > go-mode > auto presets fixture sweep (65.2 B1)', () => {
  it('Fastest picks exactly what 56.1 offers', () => {
    expect(autoPins.fastestDiff).toEqual([])
  })
  it('Stay on my route never switches route, off the bus or aboard', () => {
    expect(autoPins.stayRouteSwitches).toBe(0)
  })
  it('Least biking never bikes more than the bar', () => {
    expect(autoPins.leastBikeMoreBike).toBe(0)
  })
  it('Simplest never takes more vehicle changes than the bar', () => {
    expect(autoPins.simplestMoreChanges).toBe(0)
  })
  // Fastest is 56.1's rule verbatim and reverses once (0921-0902-orange-lake-st
  // 09:15:01 → 546+465, 09:18:03 → back to the Orange Line); holding a switch
  // is B2's job (the latch's never-again route set, or 2-answer confirmation).
  it('Least biking / Simplest never reverse a switch at the default allowance', () => {
    expect(
      autoSwitches
        .filter(
          (x) =>
            x.allowanceMs === AUTO_LATER_ALLOWANCE_MS &&
            x.preset !== 'fastest' &&
            x.reversal
        )
        .map((x) => `${x.preset} ${x.ride} ${hm(x.t)}`)
    ).toEqual([])
  })
  it('aboard Fastest is compareAlightOffer unchanged', () => {
    expect(autoPins.aboardFastestDiff).toBe(0)
  })
  it('no switch lands later than the bar by more than the allowance', () => {
    expect(
      autoSwitches.filter(
        (x) => x.preset !== 'fastest' && x.savingMs < -x.allowanceMs
      )
    ).toEqual([])
  })
})

const has = (name: string) => files.includes(`${name}.json`)
const withPin = has('orange-1639-1017') ? describe : describe.skip

describe('util > go-mode > faster-route fixtures (56.1 measure)', () => {
  it('replays the recorded background answers', () => {
    expect(totals.answers).toBeGreaterThanOrEqual(0)
  })
  it('the latch never lets a ride exceed three offers', () => {
    expect(rideOffers.filter((r) => r.offers.length > 3)).toEqual([])
  })
  it('every less-bike offer saves at least 1 km of biking', () => {
    const short = rideOffers
      .flatMap((r) => r.offers)
      .filter((o) => o.kind === 'lessBike' && o.bikeSavedM < 1000)
    expect(short).toEqual([])
    expect(bikeMetersOf(null)).toBe(0)
  })
})

withPin('util > go-mode > faster-route pin orange-1639-1017', () => {
  it('zero offers off the bus and aboard', () => {
    const vs = pinVerdicts['orange-1639-1017']
    expect(vs.length).toBeGreaterThan(0)
    expect(vs.filter((x) => x.v.kind)).toEqual([])
    // Aboard snapshots judged as if off the bus: still nothing to offer.
    expect(pinOffBusForced['orange-1639-1017'] || 0).toBe(0)
    expect(pinAboard['orange-1639-1017'] || 0).toBe(0)
    expect(
      rideOffers.find((r) => r.ride === 'orange-1639-1017')?.offers.length || 0
    ).toBe(0)
  })
})
