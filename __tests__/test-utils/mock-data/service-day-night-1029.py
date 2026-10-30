# Distils service-day-night-1029.json (backlog 75.2, chaos C21) from the
# desktop OTP (127.0.0.1:8090, jar 75457ac5b1) on 2026-10-29.
#
# C21 planned at 00:39 on 2026-10-29 and got the 18 boarding Nicollet Ave S &
# 44th St E (1:1874) at 04:26, trip 1:1361322 (SET_LIVE_LEG_TIMES boardEpoch
# 1793265960000); the app then fetched that stop for date "2026-10-28". This
# asks the same OTP for the same itinerary (bike + transit, the first plan of
# a 04:15 query is that one, ending 04:53:25 like C21's) and for the stop's
# answer on BOTH service dates, with the variables findStopTimesForStop sends
# (startTime = the date's 03:30 local, numberOfDepartures 1000).
#
# Kept: that itinerary's legs (fields the board, poll and card read, plus the
# geometry), and route 1:18's rows of each stop answer. Dropped: other routes,
# and the `rt#` patterns the realtime updater had added by 07:40 when this ran
# (nothing realtime is running at 01:30 for a 04:26 bus). No value is edited.
# Run from anywhere:  python3 service-day-night-1029.py
import datetime, json, os, urllib.request, zoneinfo

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE + '/service-day-night-1029.json'
OTP = 'http://127.0.0.1:8090/otp/gtfs/v1'
TZ = zoneinfo.ZoneInfo('America/Chicago')
STOP, ROUTE, TRIP = '1:1874', '1:18', '1:1361322'


def gql(query, variables=None):
    body = json.dumps({'query': query, 'variables': variables or {}}).encode()
    req = urllib.request.Request(OTP, body, {'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=60))['data']


PLAN = """{ plan(from: {lat: 44.9205, lon: -93.276}, to: {lat: 44.9778, lon: -93.2707},
  date: "2026-10-29", time: "04:15", numItineraries: 6,
  transportModes: [{mode: BICYCLE}, {mode: TRANSIT}]) {
  itineraries { duration endTime startTime legs {
    distance duration endTime headsign mode startTime transitLeg
    from { lat lon name stop { gtfsId } } to { lat lon name stop { gtfsId } }
    legGeometry { length points }
    route { color gtfsId id: gtfsId longName shortName textColor }
    trip { gtfsId id tripHeadsign } } } } }"""

STOP_TIMES = """query StopTimes($serviceDay: Long!, $stopId: String!) {
  stop(id: $stopId) { gtfsId code lat lon locationType name wheelchairBoarding
    routes { id: gtfsId agency { gtfsId name } longName mode color textColor shortName patterns { id headsign } }
    stoptimesForPatterns(numberOfDepartures: 1000, startTime: $serviceDay, omitNonPickups: true, omitCanceled: false) {
      pattern { desc: name headsign id: code route { agency { name gtfsId } gtfsId } }
      stoptimes { headsign departureDelay realtimeDeparture realtimeState scheduledDeparture serviceDay
        trip { blockId id pattern { id } route { gtfsId } } } } } }"""

itineraries = gql(PLAN)['plan']['itineraries']
itinerary = next(
    it for it in itineraries
    if any((l.get('trip') or {}).get('gtfsId') == TRIP for l in it['legs'])
)

stop_times = {}
for date in ('2026-10-28', '2026-10-29'):
    service_day = int(
        datetime.datetime.fromisoformat(date + 'T03:30').replace(tzinfo=TZ).timestamp()
    )
    stop = gql(STOP_TIMES, {'serviceDay': service_day, 'stopId': STOP})['stop']
    stop['routes'] = [r for r in stop['routes'] if r['id'] == ROUTE]
    stop['stoptimesForPatterns'] = [
        g for g in stop['stoptimesForPatterns']
        if g['pattern']['route']['gtfsId'] == ROUTE and 'rt#' not in g['pattern']['id']
    ]
    stop_times[date] = {'serviceDay': service_day, 'stop': stop}

json.dump({
    'source': {
        'capturedAt': datetime.datetime.now(TZ).isoformat(timespec='seconds'),
        'otp': OTP,
        'row': '75.2',
        'route': ROUTE,
        'stopId': STOP,
        'tripId': TRIP,
    },
    'itinerary': itinerary,
    'stopTimes': stop_times,
}, open(OUT, 'w'), separators=(',', ':'))
rows = {d: sum(len(g['stoptimes']) for g in v['stop']['stoptimesForPatterns']) for d, v in stop_times.items()}
print(OUT, rows, os.path.getsize(OUT), 'bytes')
