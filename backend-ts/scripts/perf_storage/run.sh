#!/bin/bash
# The storage benchmarks, each phase in a clean environment (env -i) under a macOS sandbox profile made for it.
#
#   PERF_TMP_ROOT=<the task's temporary folder> [PERF_DATA_ROOT=<the app's data folder>] run.sh <phase> [args]
#
# phases (the * ones read real data, and only through these profiles):
#   selftest            the profiles refuse what they must (synthetic files only); run first
#   synth [small|large] synthetic_db_bench.ts
#   journal [small|large] file_journal_bench.ts
#   git [small|large]   git_checkpoint_bench.ts
#   copy *              copy_index_db.py: PERF_DATA_ROOT/index.db -> $PERF_TMP_ROOT/perf-storage-private/index.db
#   dbstats *           db_stats.py on the private copy
#   realdb *            real_db_bench.ts on the private copy
#   dirstats *          dir_stats.py over PERF_DATA_ROOT/{workspaces,sandboxes,repos,logs,assets,scratch} + upgrade backups (metadata only)
#   candidates *        candidate_ab_bench.ts: baseline vs narrow projection / candidate indexes, on fresh clones
#   snapdup *           snapshot_dup_stats.py: repetition of the snapshots' path lists (aggregates)
#   ownexec *           own_executions_report.py: the audit's own executions (PERF_OWN_EXEC_MAP) from the copy
#   leakcheck           counts output lines that look like an id, a path or an address (0 expected)
#
# Folders (all under PERF_TMP_ROOT, never committed): perf-storage-private (the copy, 0700), perf-storage-scratch
# (synthetic data and working clones the benchmarks made, removed by them; nothing else is ever removed),
# perf-storage-out (aggregate JSON, 0600). The pristine copy is kept for reproducibility.
set -euo pipefail

phase="${1:?phase}"; shift || true
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
PY="$(command -v python3)"; PY_PREFIX="$(cd "$(dirname "$(readlink -f "$PY")")/.." && pwd -P)"
GIT="$(command -v git)"; GIT_PREFIX="$(cd "$(dirname "$(readlink -f "$GIT")")/.." && pwd -P)"
DATA_ROOT=""
if [ -n "${PERF_DATA_ROOT:-}" ]; then DATA_ROOT="$(cd "$PERF_DATA_ROOT" && pwd -P)"; fi
case "$TMP_ROOT/" in "$REPO/"*) echo "refused: PERF_TMP_ROOT inside the checkout" >&2; exit 2;; esac

sb_q() { printf '"%s"' "$1"; }

# the profile: no network; no reading the person's home (this checkout, bun and the task's folders excepted) nor the
# app's data folder (the task's folders excepted); writes only to the given folders; processes only the given ones
profile() {
  local writes="$1" execs="$2" extra="${3:-}"
  {
    echo '(version 1)'
    echo '(allow default)'
    echo '(deny network*)'
    echo "(deny file-read* (subpath $(sb_q "$USER_HOME_REAL")))"
    [ -n "$DATA_ROOT" ] && echo "(deny file-read* (subpath $(sb_q "$DATA_ROOT")))"
    echo "(allow file-read* (subpath $(sb_q "$REPO")) (subpath $(sb_q "$BUN_ROOT")) (subpath $(sb_q "${READ_TMP:-$TMP_ROOT}")))"
    echo '(allow file-read-metadata)'
    echo '(deny file-write*)'
    echo "(allow file-write* $writes (literal \"/dev/null\") (regex #\"^/dev/(tty|fd/|stdout|stderr)\"))"
    echo '(deny process-exec*)'
    echo "(allow process-exec* $execs)"
    printf '%s\n' "$extra"
  }
}

clean_env() {
  env -i PATH="$(dirname "$GIT"):$(dirname "$BUN"):$(dirname "$PY"):/usr/bin:/bin" LANG=C.UTF-8 \
    HOME="$SCRATCH/home" TMPDIR="$SCRATCH/tmp/" OASIS_CODE_DATA="$SCRATCH/oasis-data" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 \
    PERF_OUT="$OUT" PERF_SCRATCH="$SCRATCH" PERF_PRIVATE="$PRIVATE" PERF_SAMPLES="${PERF_SAMPLES:-}" PERF_SCALE="${PERF_SCALE:-small}" \
    PERF_INIT_REPEATS="${PERF_INIT_REPEATS:-}" PERF_ALLOW_GIT="${PERF_ALLOW_GIT:-0}" PERF_GEN_BUDGET_GIB="${PERF_GEN_BUDGET_GIB:-1}" PERF_MIN_FREE_GIB="${PERF_MIN_FREE_GIB:-6}" PERF_DEBUG_SYNTHETIC="${PERF_DEBUG_SYNTHETIC:-0}" PERF_SILENCE_CONSOLE="${PERF_SILENCE_CONSOLE:-0}" \
    PERF_GIT_VERSION="$("$GIT" --version)" PERF_REVISION="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)" "$@"
}

bun_phase() {   # bun_phase <script> <exec rules> <write rules>
  local script="$1" execs="$2" writes="$3" p="$SCRATCH/tmp/profile-$phase.sb"
  profile "$writes" "$execs" > "$p"
  (cd "$BACKEND" && clean_env /usr/bin/sandbox-exec -f "$p" "$BUN_REAL" --preload ./scripts/perf_storage/guard_preload.ts "./scripts/perf_storage/$script")
}

# free space under the task's folder, GiB (df -k: 1 KiB blocks available)
free_gib() { df -k "$TMP_ROOT" | awk 'NR==2 {printf "%d", $4 / 1048576}'; }
# a synthetic phase starts only when its generated-data budget fits above the reserve (default 6 GiB kept free)
need_free() {
  local budget="$1" reserve="${PERF_MIN_FREE_GIB:-6}" free; free="$(free_gib)"
  if [ "$free" -lt $((budget + reserve)) ]; then echo "refused: ${free} GiB free; $phase needs ${budget} GiB above a ${reserve} GiB reserve" >&2; exit 3; fi
}
budget_of() { case "$phase:${1:-small}" in synth:large) echo 3;; journal:large) echo 1;; git:large) echo 2;; *) echo 1;; esac; }

need_data() { [ -n "$DATA_ROOT" ] || { echo "PERF_DATA_ROOT must name the app's data folder for $phase" >&2; exit 2; }; }

case "$phase" in
  synth)   need_free "$(budget_of "${1:-small}")"; PERF_SCALE="${1:-small}" PERF_GEN_BUDGET_GIB="$(budget_of "${1:-small}")" bun_phase synthetic_db_bench.ts "(literal $(sb_q "$BUN_REAL"))" "(subpath $(sb_q "$SCRATCH")) (subpath $(sb_q "$OUT"))" ;;
  journal) need_free "$(budget_of "${1:-small}")"; PERF_SCALE="${1:-small}" PERF_GEN_BUDGET_GIB="$(budget_of "${1:-small}")" bun_phase file_journal_bench.ts "(literal $(sb_q "$BUN_REAL"))" "(subpath $(sb_q "$SCRATCH")) (subpath $(sb_q "$OUT"))" ;;
  git)     need_free "$(budget_of "${1:-small}")"; PERF_SCALE="${1:-small}" PERF_GEN_BUDGET_GIB="$(budget_of "${1:-small}")" PERF_ALLOW_GIT=1 bun_phase git_checkpoint_bench.ts "(literal $(sb_q "$BUN_REAL")) (literal $(sb_q "$GIT")) (subpath $(sb_q "$GIT_PREFIX")) (literal \"/usr/bin/false\") (literal \"/bin/sh\") (literal \"/bin/bash\")" "(subpath $(sb_q "$SCRATCH")) (subpath $(sb_q "$OUT"))" ;;
  realdb)  need_data; PERF_DEBUG_SYNTHETIC=0 PERF_SILENCE_CONSOLE=1 bun_phase real_db_bench.ts "(literal $(sb_q "$BUN_REAL"))" "(subpath $(sb_q "$PRIVATE")) (subpath $(sb_q "$OUT")) (subpath $(sb_q "$SCRATCH"))" ;;
  candidates) need_data; PERF_DEBUG_SYNTHETIC=0 PERF_SILENCE_CONSOLE=1 bun_phase candidate_ab_bench.ts "(literal $(sb_q "$BUN_REAL"))" "(subpath $(sb_q "$PRIVATE")) (subpath $(sb_q "$OUT")) (subpath $(sb_q "$SCRATCH"))" ;;
  snapdup)
    p="$SCRATCH/tmp/profile-snapdup.sb"
    profile "(subpath $(sb_q "$OUT"))" "(subpath \"/usr/bin\") (subpath $(sb_q "$PY_PREFIX"))" > "$p"
    clean_env /usr/bin/sandbox-exec -f "$p" "$PY" "$HERE/snapshot_dup_stats.py" --db "$PRIVATE/index.db" --out "$OUT" ;;
  copy)
    need_data
    src="$DATA_ROOT/index.db"
    p="$SCRATCH/tmp/profile-copy.sb"
    # the source folder readable; of the source only its -shm writable (a WAL reader's read mark), never the database or its WAL
    profile "(subpath $(sb_q "$PRIVATE")) (literal $(sb_q "$src-shm"))" "(subpath \"/usr/bin\") (subpath $(sb_q "$PY_PREFIX"))" \
      "(allow file-read* (literal $(sb_q "$src")) (literal $(sb_q "$src-wal")) (literal $(sb_q "$src-shm")) (literal $(sb_q "$DATA_ROOT")))" > "$p"
    clean_env /usr/sbin/taskpolicy -b /usr/bin/sandbox-exec -f "$p" "$PY" "$HERE/copy_index_db.py" --source "$src" --tmp-root "$TMP_ROOT" --dest-dir "$PRIVATE" ;;
  dbstats)
    p="$SCRATCH/tmp/profile-dbstats.sb"
    profile "(subpath $(sb_q "$OUT")) (subpath $(sb_q "$PRIVATE"))" "(subpath \"/usr/bin\") (subpath $(sb_q "$PY_PREFIX"))" > "$p"
    clean_env /usr/bin/sandbox-exec -f "$p" "$PY" "$HERE/db_stats.py" --db "$PRIVATE/index.db" --out "$OUT" ;;
  dirstats)
    need_data
    p="$SCRATCH/tmp/profile-dirstats.sb"
    # directory listings and metadata (global) under the five capacity trees; no file's content anywhere in the data
    # folder (auth files included); the private copy readable for --db
    trees=(workspaces sandboxes repos logs assets scratch)
    dirs=""; args=()
    for t in "${trees[@]}"; do
      [ -d "$DATA_ROOT/$t" ] || continue
      dirs="$dirs (require-all (subpath $(sb_q "$DATA_ROOT/$t")) (vnode-type DIRECTORY))"
      args+=(--tree "$t=$DATA_ROOT/$t")
    done
    # the data folder itself as a listing only (for the fixed index.db.v<N>.bak pattern; no file of it is read)
    dirs="$dirs (require-all (literal $(sb_q "$DATA_ROOT")) (vnode-type DIRECTORY))"
    profile "(subpath $(sb_q "$OUT"))" "(subpath \"/usr/bin\") (subpath $(sb_q "$PY_PREFIX"))" \
      "(allow file-read*$dirs)
(allow file-read* (subpath $(sb_q "$PRIVATE")))" > "$p"
    db=(); [ -f "$PRIVATE/index.db" ] && db=(--db "$PRIVATE/index.db")
    own="$(cd "$TMP_ROOT/.." && pwd -P)"   # the task's own sandbox entry, when the temporary folder lives in one
    clean_env /usr/sbin/taskpolicy -b /usr/bin/sandbox-exec -f "$p" "$PY" "$HERE/dir_stats.py" "${args[@]}" \
      --classify workspaces --classify sandboxes --backups "$DATA_ROOT" --exclude "$own" ${db[@]+"${db[@]}"} --out "$OUT" ;;
  ownexec)
    # the audit's own executions (run id and id -> category map from its receipt, PERF_OWN_EXEC_MAP), from the copy
    map="${PERF_OWN_EXEC_MAP:?PERF_OWN_EXEC_MAP must name the map (kept under PERF_TMP_ROOT)}"
    case "$(cd "$(dirname "$map")" && pwd -P)/" in "$TMP_ROOT/"*) ;; *) echo "refused: the map must be under PERF_TMP_ROOT" >&2; exit 2;; esac
    p="$SCRATCH/tmp/profile-ownexec.sb"
    profile "(subpath $(sb_q "$OUT"))" "(subpath \"/usr/bin\") (subpath $(sb_q "$PY_PREFIX"))" > "$p"
    clean_env /usr/bin/sandbox-exec -f "$p" "$PY" "$HERE/own_executions_report.py" --db "$PRIVATE/index.db" --map "$map" --out "$OUT" ;;
  leakcheck)
    # before any output is shared: how many lines of the out folder look like an identifier, a path or an e-mail
    n=$(grep -E -c '(/(Users|home|private)/|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][a-z]{2,}|(^|[^a-z])(s|p|run|ws|cp|snap|x|fj|ix|relay|note|w)_[0-9a-f]{12})' /dev/null $(ls "$OUT"/*.json 2>/dev/null | grep -v '/own_executions.json$') 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}' || true)
    echo "suspicious lines in $OUT: $n (0 expected; inspect privately before sharing anything else)" | sed "s|$OUT|\$PERF_OUT|" ;;
  selftest)
    # every probe is synthetic: a fake home and data folder under the scratch folder stand for the real ones
    fake="$SCRATCH/selftest"; rm -rf "$fake"; mkdir -p "$fake/data/workspaces/ws_a" "$fake/data/sandboxes/ws_b/home" "$fake/personal"
    echo secret > "$fake/data/workspaces/ws_a/file.txt"; echo secret > "$fake/personal/file.txt"
    USER_HOME_REAL_SAVED="$USER_HOME_REAL"; DATA_ROOT_SAVED="$DATA_ROOT"
    DATA_ROOT="$fake/data"
    p="$SCRATCH/tmp/profile-selftest.sb"
    READ_TMP="$OUT" profile "(subpath $(sb_q "$OUT"))" "(subpath \"/usr/bin\") (subpath \"/bin\")" \
      "(allow file-read* (require-all (subpath $(sb_q "$DATA_ROOT/workspaces")) (vnode-type DIRECTORY)))" > "$p"
    probe() { if clean_env /usr/bin/sandbox-exec -f "$p" /bin/sh -c "$2" >/dev/null 2>&1; then echo "$1: allowed"; else echo "$1: refused"; fi; }
    probe "list a workspaces folder (expect allowed)" "ls '$fake/data/workspaces/ws_a'"
    probe "read a file under workspaces (expect refused)" "cat '$fake/data/workspaces/ws_a/file.txt'"
    probe "read a file under the data folder (expect refused)" "ls '$fake/data/sandboxes/ws_b'"
    probe "write outside the out folder (expect refused)" "echo x > '$SCRATCH/tmp/selftest-write'"
    probe "write in the out folder (expect allowed)" "echo x > '$OUT/selftest-write' && rm -f '$OUT/selftest-write'"
    probe "network (expect refused)" "/usr/bin/nc -z -w 2 1.1.1.1 443"
    probe "read the real home (expect refused)" "ls '$USER_HOME_REAL_SAVED'"
    DATA_ROOT="$DATA_ROOT_SAVED"
    rm -rf "$fake" ;;
  *) echo "unknown phase $phase" >&2; exit 2 ;;
esac
