/* globals describe, expect, it */
import {
  matchPatternForLeg,
  riddenPatterns,
  riddenPatternShapes,
  riddenPatternStopIds,
  transitLegRouteIds
} from '../../../lib/util/go-mode/ridden-pattern'

/**
 * 3.4 / 3.3. A leg's `legGeometry` runs board stop → alight stop, so "the line
 * before I get on and after I get off" is not in the itinerary at all. It
 * comes from `findRoute`, which stores each pattern's whole shape and ordered
 * stop list under `transitIndex.routes[routeId].patterns`.
 *
 * The stop lists below are the REAL METRO Orange Line patterns, read off the
 * house OTP on 2026-09-02:
 *
 *   curl -s -X POST https://api.transit-nav.com:9966/otp/routers/default/index/graphql \
 *     -d '{"query":"{ route(id:\\"1:904\\"){ patterns { id name stops { gtfsId name } } } }"}'
 *
 * Two things in that data drive the matcher. The two directions carry
 * DIFFERENT stop ids for the same physical station (46th St is 1:53543
 * southbound and 1:53542 northbound), but they share their terminals
 * (1:56800 Gateway Ramp Layover and 1:56830 Burnsville Heart of the City) —
 * so a terminal-to-terminal leg appears in both patterns and only the ORDER of
 * the two stops says which way the rider is going.
 */

const TO_BURNSVILLE = 'UGF0dGVybjoxOjkwNDoxOjAx'
const TO_DOWNTOWN = 'UGF0dGVybjoxOjkwNDowOjAx'

const stops = (pairs: Array<[string, string]>) =>
  pairs.map(([gtfsId, name]) => ({
    gtfsId,
    id: gtfsId,
    lat: 44.9,
    lon: -93.28,
    name
  }))

const orangeLinePatterns = () => ({
  [TO_BURNSVILLE]: {
    geometry: { length: 693, points: 'burnsville_shape' },
    id: TO_BURNSVILLE,
    name: 'METRO Orange Line ORANGE Burnsville',
    stops: stops([
      ['1:56800', 'Gateway Ramp Layover'],
      ['1:53297', 'Marquette Ave & 3rd St - Stop Group C'],
      ['1:53298', 'Marquette Ave & 5th St - Stop Group C'],
      ['1:53299', 'Marquette Ave & 7th St - Stop Group C'],
      ['1:53301', 'Marquette Ave & 11th St - Stop Group C'],
      ['1:17781', 'I-35W & Lake St Station'],
      ['1:53543', 'I-35W & 46th St Station'],
      ['1:52719', 'I-35W & 66th St Station'],
      ['1:56832', 'Knox Ave & 76th St Station'],
      ['1:56884', 'Knox Ave & American Blvd Station'],
      ['1:56833', 'I-35W & 98th St Station'],
      ['1:56830', 'Burnsville Heart of the City Station']
    ])
  },
  [TO_DOWNTOWN]: {
    geometry: { length: 601, points: 'downtown_shape' },
    id: TO_DOWNTOWN,
    name: 'METRO Orange Line ORANGE Downtown Minneapolis',
    stops: stops([
      ['1:56830', 'Burnsville Heart of the City Station'],
      ['1:56829', 'I-35W & Burnsville Pkwy Station'],
      ['1:56831', 'I-35W & 98th St Station'],
      ['1:51110', 'Knox Ave & American Blvd Station'],
      ['1:56828', 'Knox Ave & 76th St Station'],
      ['1:48084', 'I-35W & 66th St Station'],
      ['1:53542', 'I-35W & 46th St Station'],
      ['1:17780', 'I-35W & Lake St Station'],
      ['1:53311', '2nd Ave S & 11th St - Stop Group F'],
      ['1:53313', '2nd Ave S & 7th St - Stop Group F'],
      ['1:53314', '2nd Ave S & 5th St - Stop Group F'],
      ['1:19260', '2nd Ave S & Washington Ave S'],
      ['1:56800', 'Gateway Ramp Layover']
    ])
  }
})

const routes = () => ({
  '1:904': {
    color: 'F68B1F',
    id: '1:904',
    longName: 'METRO Orange Line',
    patterns: orangeLinePatterns()
  }
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const busLeg = (from: string, to: string, extra: any = {}): any => ({
  from: { name: 'Board', stop: { gtfsId: from, name: extra.fromName } },
  legGeometry: { points: 'ridden_hop_only' },
  mode: 'BUS',
  route: { gtfsId: '1:904', id: '1:904' },
  to: { name: 'Alight', stop: { gtfsId: to, name: extra.toName } },
  transitLeg: true,
  ...extra
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const itineraryOf = (...legs: any[]): any => ({ legs })

describe('ridden pattern lookup (3.4 / 3.3, 2026-09-02)', () => {
  it('finds the whole line, not just the hop the rider rides', () => {
    // 66th St → 11th St downtown. The point of the whole exercise is the nine
    // stops that are NOT between those two.
    const patterns = riddenPatterns(
      itineraryOf(busLeg('1:48084', '1:53311')),
      routes()
    )
    expect(patterns).toHaveLength(1)
    expect(patterns[0].patternId).toBe(TO_DOWNTOWN)
    expect(patterns[0].stopIds).toHaveLength(13)
    // Before boarding…
    expect(patterns[0].stopIds).toContain('1:56830')
    // …and after alighting.
    expect(patterns[0].stopIds).toContain('1:56800')
    expect(riddenPatternShapes(patterns)).toEqual([
      { color: '#F68B1F', points: 'downtown_shape' }
    ])
  })

  it('picks the direction of travel when both patterns hold both stops', () => {
    // Gateway Ramp and Burnsville Heart of the City are the two terminals and
    // appear in BOTH patterns. Only the order distinguishes them, which is why
    // the match requires the board stop to come before the alight stop.
    const northbound = riddenPatterns(
      itineraryOf(busLeg('1:56830', '1:56800')),
      routes()
    )
    expect(northbound[0].patternId).toBe(TO_DOWNTOWN)

    const southbound = riddenPatterns(
      itineraryOf(busLeg('1:56800', '1:56830')),
      routes()
    )
    expect(southbound[0].patternId).toBe(TO_BURNSVILLE)
  })

  it('uses the pattern id when the plan actually carries one', () => {
    const matched = matchPatternForLeg(
      busLeg('1:48084', '1:53311', { patternId: TO_BURNSVILLE }),
      orangeLinePatterns()
    )
    expect(matched?.[0]).toBe(TO_BURNSVILLE)
  })

  it('falls back to the stop NAME for a twin-feed stop id', () => {
    // Shared stations exist under several GTFS feeds and a plan leg can name
    // the twin's id; alight-optimizer's findStopTimeIndex makes the same
    // fallback for the same reason.
    const matched = matchPatternForLeg(
      busLeg('2:99999', '1:53311', {
        fromName: 'I-35W & 66th St Station'
      }),
      orangeLinePatterns()
    )
    expect(matched?.[0]).toBe(TO_DOWNTOWN)
  })

  it('draws nothing rather than guessing when no pattern contains the hop', () => {
    // A wrong-direction shape painted under the trip is worse than no shade.
    expect(
      riddenPatterns(itineraryOf(busLeg('1:00000', '1:11111')), routes())
    ).toEqual([])
  })

  it('draws nothing until findRoute has answered', () => {
    expect(
      riddenPatterns(itineraryOf(busLeg('1:48084', '1:53311')), {})
    ).toEqual([])
    expect(
      riddenPatterns(itineraryOf(busLeg('1:48084', '1:53311')), {
        '1:904': { id: '1:904', pending: true }
      })
    ).toEqual([])
  })

  it('ignores non-transit legs and de-duplicates a repeated pattern', () => {
    const itinerary = itineraryOf(
      { legGeometry: { points: 'bike' }, mode: 'BICYCLE', transitLeg: false },
      busLeg('1:48084', '1:53311'),
      busLeg('1:56828', '1:53314'),
      { legGeometry: { points: 'walk' }, mode: 'WALK', transitLeg: false }
    )
    const patterns = riddenPatterns(itinerary, routes())
    expect(patterns).toHaveLength(1)
    expect(riddenPatternStopIds(patterns)).toHaveLength(13)
  })

  it('lists the route ids to fetch, once each', () => {
    const itinerary = itineraryOf(
      { mode: 'WALK', transitLeg: false },
      busLeg('1:48084', '1:53311'),
      busLeg('1:56828', '1:53314'),
      { ...busLeg('1:1', '1:2'), route: { gtfsId: '1:901', id: '1:901' } }
    )
    expect(transitLegRouteIds(itinerary)).toEqual(['1:904', '1:901'])
    expect(transitLegRouteIds(null)).toEqual([])
  })
})
