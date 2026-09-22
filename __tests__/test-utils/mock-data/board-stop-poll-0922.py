# Distils board-stop-poll-0922.json (backlog 26.1) out of the uncommitted replay
# fixture orange-stall-0922-0804.json and the day file debug-2026-09-22.jsonl.
# Only the fields the board-time and poll rules read are kept; no value is
# edited. Run from anywhere:  python3 board-stop-poll-0922.py
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FX = W + '/lib/util/go-mode/replay/fixtures/orange-stall-0922-0804.json'
LOG = os.path.expanduser('~/otp-debug-logs/debug-2026-09-22.jsonl')
OUT = HERE + '/board-stop-poll-0922.json'
SESSION = 'mucordp1-jqcrp2'
TRIP = '1:1346857'
STOP = '1:56831'
FROM, TO = 1790083110000, 1790084340000  # 08:18:30 - 08:39:00 local
d = json.load(open(FX))

def pick(o, keys):
    return {k: o[k] for k in keys if k in o}

def leg(l):
    out = pick(l, ['mode', 'transitLeg', 'distance', 'startTime', 'endTime', 'tripId'])
    for end in ('from', 'to'):
        e = l.get(end) or {}
        out[end] = pick(e, ['lat', 'lon', 'name'])
        if e.get('stop'):
            out[end]['stop'] = pick(e['stop'], ['gtfsId'])
    if l.get('trip'):
        out['trip'] = pick(l['trip'], ['gtfsId'])
    if l.get('route'):
        out['route'] = pick(l['route'], ['gtfsId', 'id'])
    return out

def st(s):
    o = pick(s, ['arrivalDelay', 'realtimeArrival', 'realtimeState', 'scheduledArrival', 'scheduledDeparture', 'serviceDay'])
    o['stop'] = pick(s['stop'], ['id', 'name'])
    return o

trip = [
    {'tMs': s['tMs'], 'stopTimes': [st(x) for x in s['payload']['stopTimes'][:6]]}
    for s in d['tripSnapshots']
    if s['payload']['id'] == TRIP and FROM - 60000 <= s['tMs'] <= TO + 60000
]
stops = []
for s in d['stopTimeSnapshots']:
    if s['stopId'] != STOP or not (FROM - 60000 <= s['tMs'] <= TO + 60000):
        continue
    p = s['payload']
    groups = []
    for g in p.get('stoptimesForPatterns', []):
        if g['pattern']['id'] != '1:904:0:01':
            continue
        groups.append({'pattern': pick(g['pattern'], ['id', 'headsign']), 'stoptimes': [
            {**pick(x, ['departureDelay', 'realtimeDeparture', 'realtimeState', 'scheduledDeparture', 'serviceDay']),
             'trip': pick(x['trip'], ['id'])} for x in g['stoptimes']]})
    stops.append({'tMs': s['tMs'], 'payload': {'gtfsId': p['gtfsId'], 'stoptimesForPatterns': groups}})
veh = []
for s in d['vehicleSnapshots']:
    if not (FROM - 60000 <= s['tMs'] <= TO + 60000):
        continue
    vs = s['payload']['vehicles']
    v = [x for x in vs if x.get('tripId') == TRIP]
    veh.append({'tMs': s['tMs'], 'empty': not vs,
                'vehicle': pick(v[0], ['lat', 'lon', 'nextStopId', 'seconds', 'tripId', 'vehicleId', 'label', 'stopStatus']) if v else None})

ticks, pos, llt = [], None, []
for line in open(LOG):
    if SESSION not in line:
        continue
    r = json.loads(line)
    ty, p, t = r.get('type'), r.get('payload'), r.get('t')
    if ty == 'UPDATE_POSITION':
        c = p['coords']
        pos = [c['latitude'], c['longitude'], c.get('speed')]
    elif ty == 'UPDATE_ROUTE_MATCH' and FROM <= t <= TO and pos:
        ticks.append({'tMs': t, 'legIndex': p['legIndex'], 'progressAlongLeg': round(p['progressAlongLeg'], 6),
                      'lat': round(pos[0], 7), 'lon': round(pos[1], 7),
                      'speed': None if pos[2] is None else round(pos[2], 3)})
    elif ty == 'SET_LIVE_LEG_TIMES' and FROM - 60000 <= t <= TO + 60000:
        l1 = (p or {}).get('1')
        if l1:
            llt.append({'tMs': t, **pick(l1, ['boardEpoch', 'boardIsFloor', 'boardRealtime', 'boardSource'])})

out = {
    'meta': {'session': SESSION, 'source': 'orange-stall-0922-0804.json + debug-2026-09-22.jsonl',
             'window': '08:18:30-08:39:00 America/Chicago', 'trip': TRIP, 'stop': STOP},
    'legs': [leg(l) for l in d['itinerary']['legs']],
    'recordedLiveLegTimes': llt,
    'stopSnapshots': stops,
    'ticks': ticks,
    'tripSnapshots': trip,
    'vehicles': veh,
}
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print(len(ticks), len(trip), len(stops), len(veh), len(llt))
