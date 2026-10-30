# Part of the perf harness (75.35 P8b): scripts/perf/tools/. Reads a Chrome trace written by TRACE=1
# Ancestor chains of the N longest spans named <name> on the renderer main thread.
import json, sys, collections
d = json.load(open(sys.argv[1])); target = sys.argv[2]; N = int(sys.argv[3]) if len(sys.argv) > 3 else 5
ev = d['traceEvents'] if isinstance(d, dict) else d
names = {(e['pid'], e['tid']): e['args']['name'] for e in ev if e.get('ph') == 'M' and e.get('name') == 'thread_name'}
mains = [k for k, v in names.items() if v == 'CrRendererMain']
cnt = collections.Counter((e['pid'], e['tid']) for e in ev if (e.get('pid'), e.get('tid')) in mains)
main = cnt.most_common(1)[0][0]
spans = []; stack = {}
for e in ev:
    if (e.get('pid'), e.get('tid')) != main: continue
    ph = e.get('ph')
    if ph == 'X' and 'dur' in e: spans.append((e['ts'], e['ts'] + e['dur'], e['name'], e.get('args', {})))
    elif ph == 'B': stack.setdefault(e['name'], []).append(e)
    elif ph == 'E' and stack.get(e['name']):
        b = stack[e['name']].pop(); spans.append((b['ts'], e['ts'], b['name'], b.get('args', {})))
spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))
parent = [-1] * len(spans); st = []
for i, (a, b, n, args) in enumerate(spans):
    while st and spans[st[-1]][1] <= a: st.pop()
    parent[i] = st[-1] if st else -1
    st.append(i)
hits = sorted([i for i, s in enumerate(spans) if s[2] == target], key=lambda i: spans[i][0] - spans[i][1])[:N]
for i in hits:
    print(f'== {target} {(spans[i][1]-spans[i][0])/1000:.1f} ms')
    j = parent[i]
    while j >= 0:
        a, b, n, args = spans[j]
        data = args.get('data') or args.get('beginData') or {}
        extra = ''
        if isinstance(data, dict):
            extra = ' '.join(f'{k}={str(data[k])[:90]}' for k in ('functionName', 'url', 'lineNumber', 'type', 'frame') if k in data and k != 'frame')
        print(f'   <- {n} {(b-a)/1000:.1f} ms {extra}')
        j = parent[j]
