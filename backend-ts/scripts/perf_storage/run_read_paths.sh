#!/bin/bash
# read_paths_bench.ts (schema v33's read paths against v32) under the isolation of run.sh: a clean environment (env -i),
# a macOS sandbox profile with no network, no reading of the person's home (this checkout, bun and the task's folders
# excepted) nor of the app's data folder, writes only to the given folders, no process but bun; guard_preload.ts in the
# process (no fetch, no child process, provider keys removed, the console silenced for the real copy).
#
#   PERF_TMP_ROOT=<the task's temporary folder> run_read_paths.sh synth [small|large]
#   PERF_TMP_ROOT=<the audit's temporary folder> PERF_DATA_ROOT=<the app's data folder, denied> run_read_paths.sh real
#
# synth: a synthetic v32 database built in $PERF_TMP_ROOT/perf-storage-scratch, removed by the script with every clone.
# real:  $PERF_TMP_ROOT/perf-storage-private/index.db, the closed v32 copy the audit's own harness made (run.sh copy);
#        it is never opened; clones rp-*.db beside it, each removed with its -wal, -shm, .v32.bak and .v32.bak.partial.
#        PERF_READPATHS_SECTIONS=ab (default) or ab,upgrade; PERF_INIT_REPEATS (upgrade, default 1).
# Output: $PERF_TMP_ROOT/perf-storage-out/read_paths_*.json (0600): labels, counts, ms, bytes, booleans, SQL, plans.
set -euo pipefail

phase="${1:?phase: synth | real}"; shift || true
: "${PERF_TMP_ROOT:?PERF_TMP_ROOT must name the temporary folder of this task}"
TMP_ROOT="$(cd "$PERF_TMP_ROOT" && pwd -P)"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
BACKEND="$(cd "$HERE/../.." && pwd -P)"
REPO="$(cd "$BACKEND/.." && pwd -P)"
PRIVATE="$TMP_ROOT/perf-storage-private"
SCRATCH="$TMP_ROOT/perf-storage-scratch"
OUT="$TMP_ROOT/perf-storage-out"
mkdir -p "$SCRATCH/home" "$SCRATCH/tmp" "$SCRATCH/oasis-data" "$OUT"
chmod 700 "$SCRATCH" "$OUT"
USER_HOME_REAL="$(cd ~ && pwd -P)"          # only to refuse reading it
BUN="$(command -v bun)"; BUN_REAL="$(cd "$(dirname "$BUN")" && pwd -P)/$(basename "$BUN")"
BUN_ROOT="$(cd "$(dirname "$BUN_REAL")/.." && pwd -P)"
DATA_ROOT=""
if [ -n "${PERF_DATA_ROOT:-}" ]; then DATA_ROOT="$(cd "$PERF_DATA_ROOT" && pwd -P)"; fi
case "$TMP_ROOT/" in "$REPO/"*) echo "refused: PERF_TMP_ROOT inside the checkout" >&2; exit 2;; esac

sb_q() { printf '"%s"' "$1"; }

profile() {
  local writes="$1"
  echo '(version 1)'
  echo '(allow default)'
  echo '(deny network*)'
  echo "(deny file-read* (subpath $(sb_q "$USER_HOME_REAL")))"
  [ -n "$DATA_ROOT" ] && echo "(deny file-read* (subpath $(sb_q "$DATA_ROOT")))"
  echo "(allow file-read* (subpath $(sb_q "$REPO")) (subpath $(sb_q "$BUN_ROOT")) (subpath $(sb_q "$TMP_ROOT")))"
  echo '(allow file-read-metadata)'
  echo '(deny file-write*)'
  echo "(allow file-write* $writes (literal \"/dev/null\") (regex #\"^/dev/(tty|fd/|stdout|stderr)\"))"
  echo '(deny process-exec*)'
  echo "(allow process-exec* (literal $(sb_q "$BUN_REAL")))"
}

run_bench() {   # run_bench <write rules> <env assignments…>
  local writes="$1"; shift
  local p="$SCRATCH/tmp/profile-read-paths-$phase.sb"
  profile "$writes" > "$p"
  (cd "$BACKEND" && env -i PATH="$(dirname "$BUN"):/usr/bin:/bin" LANG=C.UTF-8 \
    HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" OASIS_CODE_DATA="$SCRATCH/oasis-data" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    PERF_OUT="$OUT" PERF_SCRATCH="$SCRATCH" PERF_PRIVATE="$PRIVATE" PERF_SAMPLES="${PERF_SAMPLES:-}" PERF_INIT_REPEATS="${PERF_INIT_REPEATS:-}" \
    PERF_READPATHS_SECTIONS="${PERF_READPATHS_SECTIONS:-}" PERF_GEN_BUDGET_GIB="${PERF_GEN_BUDGET_GIB:-3}" PERF_MIN_FREE_GIB="${PERF_MIN_FREE_GIB:-6}" \
    PERF_REVISION="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)" "$@" \
    /usr/bin/sandbox-exec -f "$p" "$BUN_REAL" --preload ./scripts/perf_storage/guard_preload.ts ./scripts/perf_storage/read_paths_bench.ts)
}

case "$phase" in
  synth)
    scale="${1:-small}"
    run_bench "(subpath $(sb_q "$SCRATCH")) (subpath $(sb_q "$OUT"))" PERF_MODE=synthetic PERF_SCALE="$scale" PERF_SILENCE_CONSOLE=0 PERF_DEBUG_SYNTHETIC="${PERF_DEBUG_SYNTHETIC:-0}" ;;
  real)
    [ -n "$DATA_ROOT" ] || { echo "PERF_DATA_ROOT must name the app's data folder (it is denied to the process)" >&2; exit 2; }
    [ -f "$PRIVATE/index.db" ] || { echo "no closed copy at \$PERF_TMP_ROOT/perf-storage-private/index.db (made by the audit's run.sh copy)" >&2; exit 2; }
    run_bench "(subpath $(sb_q "$PRIVATE")) (subpath $(sb_q "$OUT")) (subpath $(sb_q "$SCRATCH"))" PERF_MODE=real PERF_SILENCE_CONSOLE=1 PERF_DEBUG_SYNTHETIC=0
    # what this phase made beside the copy and did not remove (it removes each clone it made): listed by name pattern only
    left="$(find "$PRIVATE" -maxdepth 1 -name 'rp-*' | wc -l | tr -d ' ')"
    echo "rp-* files left in the private folder: $left (0 expected)" ;;
  *) echo "unknown phase $phase" >&2; exit 2 ;;
esac
