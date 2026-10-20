#!/bin/sh
# Main-thread micro-benchmarks (gomode/perf-audit): one bench file per call, in docker, PERF_BENCH=1.
#   usage: scripts/perf/bench.sh <file in __tests__/perf, e.g. results-extras.perf.ts> [jest args...]
# A plain `yarn unit` skips these specs. This checkout is mounted at /app; node_modules comes from
# $OTPRR_MAIN/node_modules (default /home/rwt/projects/otprr/otp-react-redux, read-only use).
# Inputs that are NOT in the repo are mounted read-only from host dirs (a missing one skips its spec):
#   PERF_CAPTURES_DIR  store captures capture*.json   default $PERF_SCRATCH/perf  -> /perfdata
#   PERF_AUDIT_DIR     debuglog-window-*.json         default $PERF_SCRATCH/audit -> /auditdata
#   PERF_FIXTURES_DIR  Go Mode replay fixtures        default $OTPRR_MAIN/lib/util/go-mode/replay/fixtures
#                      (the untracked ones live only there; else this repo's)     -> /perffixtures
# PERF_SCRATCH defaults to ./tmp. Extra knobs go in DENV, e.g. DENV="-e PERF_KS=1,4 -e PERF_NOCLONE=1".
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T="${1:?usage: bench.sh <__tests__/perf file> [jest args...]}"; shift
case "$T" in __tests__/*) ;; *) T="__tests__/perf/$T" ;; esac
MAIN="${OTPRR_MAIN:-/home/rwt/projects/otprr/otp-react-redux}"
SCRATCH="${PERF_SCRATCH:-$ROOT/tmp}"
FX_REL=lib/util/go-mode/replay/fixtures
[ -d "$MAIN/$FX_REL" ] && FX_DEF="$MAIN/$FX_REL" || FX_DEF="$ROOT/$FX_REL"
MOUNTS=""
# mount host dir $1 at $2 only if it exists (docker would create a root-owned empty dir)
mnt() { if [ -d "$1" ]; then MOUNTS="$MOUNTS -v $1:$2:ro"; else echo "bench.sh: no $1 (spec will skip)" >&2; fi; }
mnt "${PERF_CAPTURES_DIR:-$SCRATCH/perf}" /perfdata
mnt "${PERF_FIXTURES_DIR:-$FX_DEF}" /perffixtures
mnt "${PERF_AUDIT_DIR:-$SCRATCH/audit}" /auditdata
# shellcheck disable=SC2086
exec docker run --rm -e NODE_ENV=test -e PERF_BENCH=1 $DENV $MOUNTS \
  -v "$ROOT":/app -v "$MAIN/node_modules":/app/node_modules \
  -w /app node:20-alpine yarn jest "$T" "$@" 2>&1
