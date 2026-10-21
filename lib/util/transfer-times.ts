import { Itinerary, Leg } from '@opentripplanner/types'

/**
 * What a transit→transit change at a stop needs to show about the vehicle the
 * rider arrives on (backlog 61.1). A stop row's time column belongs to the leg
 * that LEAVES the stop, so without this mark it only ever shows the outgoing
 * bus and the arriving bus's live arrival is lost.
 */
export interface TransferArrivalMark {
  delay: number
  realtime: boolean
  time: number
}

type LegWithAlight = Leg & {
  alightRealtime?: boolean
  arrivalDelay?: number
  interlineWithPreviousLeg?: boolean
}

const isTransit = (leg?: Leg): boolean => !!leg && !!leg.transitLeg

/**
 * Marks `leg.from.transferArrival` on every transit leg that follows another
 * transit leg directly (no walk or bike between, not the same vehicle
 * continuing). Mutates the itinerary it is given: pass a clone.
 */
export function markTransfers(itinerary: Itinerary): Itinerary {
  const legs = (itinerary?.legs || []) as LegWithAlight[]
  for (let i = 1; i < legs.length; i++) {
    const leg = legs[i]
    const prev = legs[i - 1]
    if (!isTransit(leg) || !isTransit(prev)) continue
    if (leg.interlineWithPreviousLeg) continue
    if (!Number.isFinite(Number(prev.endTime))) continue
    leg.from = {
      ...leg.from,
      transferArrival: {
        delay: prev.arrivalDelay ?? 0,
        realtime: !!(prev.alightRealtime ?? prev.realTime),
        time: Number(prev.endTime)
      } as TransferArrivalMark
    } as Leg['from']
  }
  return itinerary
}
