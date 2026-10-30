# Part of the perf harness (75.35 P8b): scripts/perf/tools/. Reads a Chrome trace written by TRACE=1
# Self time per trace-event name on the renderer main thread, overall and
# inside the longest top-level task. Usage: python3 -I trace-top.py <trace.json> [N]
import json, sys, collections
d = json.load(open(sys.argv[1])); N = int(sys.argv[2]) if len(sys.argv) > 2 else 15
ev = d['traceEvents'] if isinstance(d, dict) else d
names = {}
for e in ev:
    if e.get('ph') == 'M' and e.get('name') == 'thread_name':
        names[(e['pid'], e['tid'])] = e['args']['name']
mains = [k for k, v in names.items() if v == 'CrRendererMain']
cnt = collections.Counter((e['pid'], e['tid']) for e in ev if (e.get('pid'), e.get('tid')) in mains)
main = cnt.most_common(1)[0][0]
spans = []
stack = {}
for e in ev:
    if (e.get('pid'), e.get('tid')) != main: continue
    ph = e.get('ph')
    if ph == 'X' and 'dur' in e:
        spans.append((e['ts'], e['ts'] + e['dur'], e['name'], e.get('args', {})))
    elif ph == 'B':
        stack.setdefault(e['name'], []).append(e)
    elif ph == 'E' and stack.get(e['name']):
        b = stack[e['name']].pop()
        spans.append((b['ts'], e['ts'], b['name'], b.get('args', {})))
spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))
# self time via nesting
selfd = collections.Counter(); tops = []
st = []
selfs = [0.0] * len(spans)
parent = [-1] * len(spans)
for i, (a, b, n, args) in enumerate(spans):
    while st and spans[st[-1]][1] <= a: st.pop()
    parent[i] = st[-1] if st else -1
    st.append(i)
for i, (a, b, n, args) in enumerate(spans):
    selfs[i] += (b - a)
    if parent[i] >= 0: selfs[parent[i]] -= (b - a)
def topof(i):
    while parent[i] >= 0: i = parent[i]
    return i
for i, s in enumerate(spans): selfd[s[2]] += selfs[i]
print('main thread', main, 'spans', len(spans))
print('-- overall self ms by event name')
for n, us in selfd.most_common(N): print(f'  {us/1000:8.1f}  {n}')
# longest top-level tasks
roots = [i for i in range(len(spans)) if parent[i] < 0]
roots.sort(key=lambda i: spans[i][0] - spans[i][1])
for r in roots[:3]:
    a, b, n, args = spans[r]
    print(f'-- top-level task {n} {(b-a)/1000:.1f} ms; self by name inside:')
    c = collections.Counter(); cc = collections.Counter()
    for i in range(len(spans)):
        if topof(i) == r: c[spans[i][2]] += selfs[i]; cc[spans[i][2]] += 1
    for nn, us in c.most_common(N): print(f'  {us/1000:8.1f}  {nn} (x{cc[nn]})')
    # details for the biggest layout / style events
    big = sorted([i for i in range(len(spans)) if topof(i) == r and spans[i][2] in ('UpdateLayoutTree', 'Layout', 'RecalculateStyles', 'ParseAuthorStyleSheet', 'Paint', 'PrePaint', 'Layerize', 'UpdateLayer', 'ScheduleStyleRecalculation', 'InvalidateLayout')], key=lambda i: spans[i][0] - spans[i][1])[:5]
    for i in big:
        a2, b2, n2, ar = spans[i]
        print(f'     {n2} {(b2-a2)/1000:.1f} ms args={json.dumps(ar)[:300]}')
