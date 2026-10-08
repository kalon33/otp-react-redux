# Distils live-board-timer-0930.json (backlog 38.2) out of the uncommitted
# replay fixture ride-0930-1648.json (session muomy26h-g1zujp, dev 2026.0930.1).
# Kept: the itinerary in force over the platform wait (the 16:59:03 swap; legs
# whole, the top-level query blobs dropped), every recorded fix 16:59:03 -
# 17:10:00, and the instants the app polled the boarding stop 1:53543 in that
# window. No value is edited. Run from anywhere:  python3 live-board-timer-0930.py
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
W = os.path.normpath(os.path.join(HERE, '..', '..', '..'))
FX = W + '/lib/util/go-mode/replay/fixtures/ride-0930-1648.json'
if not os.path.exists(FX):
    FX = os.path.expanduser('~/projects/otprr/otp-react-redux/lib/util/go-mode/replay/fixtures/ride-0930-1648.json')
OUT = HERE + '/live-board-timer-0930.json'
STOP = '1:53543'
d = json.load(open(FX))
swap = d['itinerarySwaps'][1]
FROM, TO = swap['tMs'], 1790806200000  # 16:59:03.386 - 17:10:00 local
it = swap['itinerary']
itinerary = {k: it[k] for k in ('duration', 'endTime', 'legs', 'startTime', 'transfers', 'waitingTime', 'walkTime', 'walkDistance') if k in it}
fixes = [p for p in d['gpsTrack'] if FROM <= p['tMs'] <= TO]
polls = [s['tMs'] for s in d['stopTimeSnapshots'] if s['stopId'] == STOP and FROM <= s['tMs'] <= TO]
json.dump({
    'source': {'fixture': 'ride-0930-1648.json', 'session': d['meta']['session'], 'fromMs': FROM, 'toMs': TO, 'stopId': STOP},
    'itinerary': itinerary,
    'fixes': fixes,
    'recordedStopPolls': polls,
}, open(OUT, 'w'), separators=(',', ':'))
print(OUT, len(fixes), 'fixes', len(polls), 'polls', os.path.getsize(OUT), 'bytes')
