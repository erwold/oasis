#!/bin/bash
# Completed-run retention A/B: the method behind results/ (see README.md), runnable on a checkout of this branch.
# One worktree, one harness: scripts/perf/bench_lifecycle.ts and its import closure (lib/app.ts, lib/env.ts,
# lib/fixtures.ts, lib/stats.ts), checked against the hashes below before every process, as is timed_run.py.
# States: before = runner.ts as of BASE (its git blob checked), every other file as checked out;
#         after  = runner.ts as checked out (copied into the AB root first; put back, and its blob checked, on any exit,
#                  INT or TERM included; a failed restore exits 97 and keeps the copy).
# Stages, each a fresh process, in this order: before-long, before-mixed, after-long, after-mixed.
#   long  = --long-history 500 (3 tool calls a turn) --long-runs 20 --long-warmup 2 --window 2000000 (22 continuations)
#   mixed = --runs 300 --warmup 30 --sample 25 (300 runs in all incl. 30 warm-up; trend over the 270 after; 100/100/100)
# Each stage folder: wrapper.txt (start/end UTC and the monotonic elapsed of the whole bun command, both taken by
# timed_run.py around one subprocess; loadavg; the command's own exit status), stdout.log, stderr.log, out/.
# Exit: 0 only when every stage exited 0 and runner.ts was restored; 98 when a stage failed (status.txt says which).
# HOME and CODEX_HOME are never set. Each stage's TMPDIR is a new folder under the system temp folder (outside the
# app's data directory, which the harness refuses); the harness puts its own data root there and removes it at exit.
# usage: AB_ROOT=<new folder> SYS_TMPDIR=<system temp folder> bash scripts/perf/retention/ab_lifecycle.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
BACK=$(cd "$HERE/../../.." && pwd)
WT=$(cd "$BACK/.." && pwd)
RUNNER=backend-ts/src/agent/runner.ts
BASE=${BASE:-a4dc9ca3bfddfa9cc57b50ba5f68c914a5772d10}
TIMER=$HERE/timed_run.py
TIMER_SHA=ac67e3d20f85e2e87125182fcfd39069f22ef2bd59fc351dd43d15e32072912e
MANIFEST_TEXT='49b40324ccf835ec682b2fd1be2d74b5fadda57256db8326649c29ac212d228a  bench_lifecycle.ts
0e8215511b8e0577bcf8ec2e1c7a008095a66ed87f1c3a4f5b6a667e437f9521  lib/app.ts
207a78cac0cf5c172ef4680301850578191d151cea4d142db1bc8c5403d3289a  lib/env.ts
67322f3da3e2cacaa53fe24d4722452c371827166f20bcc8d3f1876171075b5f  lib/fixtures.ts
27fb3ad7fee2dc04dee3cb9031f32ff55644cb54728415c78342000246047816  lib/stats.ts'
MANIFEST_SHA=d5692a6a6fc8bb82980702498d55e36a296019cfdb7a12f8060fa2a7a7c6fb3b
STAGE_CODES=""
FAILED=0

[ -n "${AB_ROOT:-}" ] || { echo "AB_ROOT: a new folder for the records"; exit 89; }
[ ! -e "$AB_ROOT" ] || { echo "AB root exists already: $AB_ROOT"; exit 89; }
mkdir -p "$AB_ROOT"
AB=$(cd "$AB_ROOT" && pwd)
exec > >(tee -a "$AB/ab.log") 2>&1
SYS_TMP=$(cd "${SYS_TMPDIR:-/tmp}" && pwd -P)
case "$SYS_TMP/" in "$HOME/.oasis-code/"*) echo "system temp folder is inside the data directory: refusing"; exit 88;; esac
BENCH_TMP_ROOT=$SYS_TMP/oasis-retention-ab-$(basename "$AB")
[ ! -e "$BENCH_TMP_ROOT" ] || { echo "bench temp root exists already: $BENCH_TMP_ROOT"; exit 88; }
mkdir -p "$BENCH_TMP_ROOT"
MANIFEST=$AB/harness.sha256
printf '%s\n' "$MANIFEST_TEXT" > "$MANIFEST"

cd "$WT" || exit 90
check_harness() {
  [ "$(shasum -a 256 "$TIMER" | cut -d' ' -f1)" = "$TIMER_SHA" ] || { echo "TIMER FILE CHANGED"; exit 91; }
  [ "$(shasum -a 256 "$MANIFEST" | cut -d' ' -f1)" = "$MANIFEST_SHA" ] || { echo "MANIFEST FILE CHANGED"; exit 91; }
  (cd "$BACK/scripts/perf" && shasum -a 256 -c --quiet "$MANIFEST") || { echo "HARNESS HASH MISMATCH"; exit 92; }
}
BASE_BLOB=$(git rev-parse "$BASE:$RUNNER") || exit 93
AFTER_COPY=$AB/runner.after.ts
cp "$RUNNER" "$AFTER_COPY" || exit 93
AFTER_BLOB=$(git hash-object "$AFTER_COPY")
[ "$AFTER_BLOB" != "$BASE_BLOB" ] || { echo "runner.ts is already the base version: refusing"; exit 93; }
git diff "$BASE" -- "$RUNNER" > "$AB/production.patch"
RESTORED_OK=1
restore_after() {
  if cp "$AFTER_COPY" "$RUNNER" && [ "$(git hash-object "$RUNNER")" = "$AFTER_BLOB" ]; then
    RESTORED_OK=1; echo "runner.ts restored to the after version ($AFTER_BLOB)"
  else
    RESTORED_OK=0; echo "RESTORE FAILED: runner.ts is not the after version; the after copy is kept at $AFTER_COPY"
  fi
}
on_exit() {
  local code=$?
  restore_after
  echo "stage_exits:$STAGE_CODES"
  if [ "$RESTORED_OK" != 1 ]; then echo "final_status=restore_failed"; exit 97; fi
  if [ "$code" = 0 ] && [ "$FAILED" != 0 ]; then code=98; fi
  echo "final_status=exit $code"
  exit "$code"
}
trap on_exit EXIT
trap 'echo "interrupted (SIGINT)"; exit 130' INT
trap 'echo "terminated (SIGTERM)"; exit 143' TERM
check_harness

{
  echo "worktree_head=$(git rev-parse HEAD)"; echo "base=$BASE"; echo "base_runner_blob=$BASE_BLOB"; echo "after_runner_blob=$AFTER_BLOB"
  echo "harness_manifest_sha256=$MANIFEST_SHA"; echo "bun=$(bun --version)"; echo "platform=$(uname -sm)"
} > "$AB/environment.txt"

run_one() {  # state scenario expected_blob args...
  local state=$1 scenario=$2 expected=$3; shift 3
  local dir=$AB/$state-$scenario
  local btmp=$BENCH_TMP_ROOT/$state-$scenario
  [ ! -e "$dir" ] || { echo "stage directory exists already: $dir"; exit 95; }
  [ ! -e "$btmp" ] || { echo "stage temp exists already: $btmp"; exit 95; }
  mkdir -p "$btmp" "$dir/out"
  check_harness
  local blob; blob=$(git hash-object "$RUNNER")
  [ "$blob" = "$expected" ] || { echo "runner.ts blob $blob is not the $state version $expected"; exit 96; }
  {
    echo "state=$state"; echo "scenario=$scenario"; echo "runner_blob=$blob"; echo "harness_manifest_sha256=$MANIFEST_SHA"
    echo "cmd=bun run scripts/perf/bench_lifecycle.ts $* --out <stage>/out"
    echo "env_set=TMPDIR=<stage temp> PERF_FIXED_ROOT=1"
    echo "start_loadavg=$(sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg 2>/dev/null)"
  } > "$dir/wrapper.txt"
  env TMPDIR="$btmp" PERF_FIXED_ROOT=1 python3 "$TIMER" "$dir/wrapper.txt" "$BACK" "$dir/stdout.log" "$dir/stderr.log" -- \
    bun run scripts/perf/bench_lifecycle.ts "$@" --out "$dir/out"
  local code=$?
  echo "end_loadavg=$(sysctl -n vm.loadavg 2>/dev/null || cat /proc/loadavg 2>/dev/null)" >> "$dir/wrapper.txt"
  STAGE_CODES="$STAGE_CODES $state-$scenario=$code"
  [ "$code" = 0 ] || FAILED=1
  (cd "$dir/out" && shasum -a 256 ./* > ../out.sha256 2>/dev/null)
  if [ -z "$(ls -A "$btmp" 2>/dev/null)" ]; then rmdir "$btmp"; else echo "note=stage temp not empty after the process (left as is)" >> "$dir/wrapper.txt"; fi
  echo "$state-$scenario exit=$code" | tee -a "$AB/status.txt"
}

LONG=(--long-history 500 --long-runs 20 --long-warmup 2 --window 2000000 --name lifecycle_long)
MIXED=(--runs 300 --warmup 30 --sample 25)

git show "$BASE:$RUNNER" > "$RUNNER"
[ "$(git hash-object "$RUNNER")" = "$BASE_BLOB" ] || { echo "could not put the base runner.ts in place"; exit 94; }
run_one before long "$BASE_BLOB" "${LONG[@]}"
run_one before mixed "$BASE_BLOB" "${MIXED[@]}"
restore_after
[ "$RESTORED_OK" = 1 ] || exit 97
run_one after long "$AFTER_BLOB" "${LONG[@]}"
run_one after mixed "$AFTER_BLOB" "${MIXED[@]}"
check_harness
rmdir "$BENCH_TMP_ROOT" 2>/dev/null || true
echo "AB root: $AB"
