#!/bin/bash
# A targeted re-measurement of the spread case only (5,000 files written once each, 4 KiB): the case where the
# FileJournal grouping A/B (journal_grouping_ab.sh) left an unattributed +0–12% on the fix side. It runs the frozen
# journal bench's method on that one scenario, 3 paired rounds, and stamps each run.
#
#   PERF_TMP_ROOT=<the task's temporary folder> [BASE_REV=<sha>] [FIX_REV=<sha>|WORKTREE] journal_spread_recheck.sh
#
# How the one scenario is selected, without touching a frozen file:
# * Two trees are extracted, base (BASE_REV, default main a4dc9ca) and fix (FIX_REV, default WORKTREE), as
#   journal_grouping_ab.sh does. The harness is the fix tree's, copied whole into the base tree. Every frozen and
#   measured file is checked against its SHA-256 (below) and kept as it is in both trees.
# * In each tree two private entry points are generated next to the originals, each by exactly one line replaced,
#   with the count checked:
#   - file_journal_bench_spread5000.gen.ts is file_journal_bench.ts with line 31,
#     `  for (const sc of SCENARIOS) {`, replaced by
#     `  for (const sc of SCENARIOS.filter((s) => s.name === 'spread' && s.writes === 5000 && s.bytes === 4096)) {`.
#     Spread 5,000 is already the first large scenario, so it runs as before; the scenarios after it are not run. No
#     fixture, timer, read, budget, statistic or cleanup line changes.
#   - run_spread5000.gen.sh is run.sh with the `journal)` line naming the generated bench instead of
#     file_journal_bench.ts. The sandbox profile, the env -i environment, the preload guard, the disk checks and the
#     bun invocation are run.sh's own lines.
#   Both generated files must be byte-identical between the trees. The manifest records the SHA-256 of each original
#   and each generated file, and the diff of each generated file against its original (one line each).
# * Run: PERF_SCALE=large through the generated run.sh, as `journal large`. The bench's samples are unchanged: 2
#   warm-ups and 10 samples (5 for diff), then one undoRun, through the production path. PERF_SAMPLES is refused.
#   Order: r1 base→fix, r2 fix→base, r3 base→fix.
# * Recorded around each run (runs.tsv) and the whole batch: UTC and monotonic start and end, the load average
#   (1/5/15 min), free bytes, the run's position and exit. These describe conditions only; they explain nothing by
#   themselves.
# * Not repeated: the equivalence seeds, the other scenarios.
#
# Afterwards journal_grouping_ab_summary.py (unchanged) summarizes the runs, paired.tsv gives the per-pair ratios, and
# the leak check runs. Then the two extracted trees are removed (only they: they were made here).
# Estimated wall time: about 2 minutes (6 runs of about 15 s, plus extraction, dependency clones and the selftest).
set -euo pipefail

: "${PERF_TMP_ROOT:?PERF_TMP_ROOT must name the temporary folder of this task}"
[ -z "${PERF_SAMPLES:-}" ] || { echo "refused: PERF_SAMPLES is frozen at the bench's default (10); unset it" >&2; exit 2; }
TMP_ROOT="$(cd "$PERF_TMP_ROOT" && pwd -P)"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../../.." && pwd -P)"
case "$TMP_ROOT/" in "$REPO/"*) echo "refused: PERF_TMP_ROOT inside the checkout" >&2; exit 2;; esac
BASE_REV="${BASE_REV:-a4dc9ca3bfddfa9cc57b50ba5f68c914a5772d10}"
FIX_REV="${FIX_REV:-WORKTREE}"
AB="$TMP_ROOT/journal-spread-recheck"
OUT="$TMP_ROOT/journal-spread-recheck-out-$(date -u +%Y%m%dT%H%M%SZ)"
P=backend-ts/scripts/perf_storage
HARNESS=(file_journal_bench.ts common.ts guard_preload.ts journal_grouping_equivalence.ts journal_grouping_ab.sh journal_grouping_ab_summary.py run.sh)
# the frozen audit files, and the files the A/B of 2026-10-18 16:51–16:54 UTC measured with
EXPECTED="$P/file_journal_bench.ts=0a14f4cb45a91b96d62436650680b14663988dc3c1ce873c3db8ba21e57c4621
$P/common.ts=6256511602fa422b9a99a91d42f3941af5bd88cde509b9b93b45301ecb2e71c6
$P/guard_preload.ts=eac87505eb5fe518342ae8d5af755c23be9135c33508ca57f15f976857119141
$P/run.sh=a030d93e710acfc27b85e1638f4a9bae8baab9035611f2e0e0178e4716b2a1c5
$P/journal_grouping_ab.sh=feae6ae03e6dd01c1afcdb8d6a533b2f64075283a520612eb51450bcbd3a4af2
$P/journal_grouping_ab_summary.py=a7158d2583de80d0ea3df7f75a86ab91e48341403479e1f44696cb3ac619ae2c
$P/journal_grouping_equivalence.ts=51e0f0a2051026d40879e909414730412814fb74b0dc0776a76e23758273205a
backend-ts/src/workspace/journal.ts=7b5ba75403199506eebc12e12c73dd7b25f92f7e4043d57c91efa541f6f43968
backend-ts/tests/test_journal_grouping.test.ts=901c75b07f9e9755d3595e0386bcc1cf3927c6458e44bde03e52a3bf51ab8c82"
BASE_JOURNAL_SHA=c19a4584d3f244ac4666b9da8be2a8f3e4e5e09b748c824b5a537c0610a680da
BENCH_FROM='  for (const sc of SCENARIOS) {'
BENCH_TO="  for (const sc of SCENARIOS.filter((s) => s.name === 'spread' && s.writes === 5000 && s.bytes === 4096)) {"

say() { printf '[spread] %s\n' "$*"; }
sha_of() { shasum -a 256 "$1" | cut -c1-64; }
free_gib() { df -k "$TMP_ROOT" | awk 'NR==2 {printf "%d", $4 / 1048576}'; }
# one line of conditions: UTC (ms), monotonic ns, load 1/5/15, free bytes of the task's file system
stamp() { python3 -c 'import datetime,os,shutil,sys,time; u=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"); m=time.monotonic_ns(); l=os.getloadavg(); f=shutil.disk_usage(sys.argv[1]).free; print(f"{u}\t{m}\t{l[0]:.2f}/{l[1]:.2f}/{l[2]:.2f}\t{f}")' "$TMP_ROOT"; }

[ "$(free_gib)" -ge 8 ] || { echo "refused: $(free_gib) GiB free; the recheck needs 2 GiB above the 6 GiB reserve" >&2; exit 3; }
for d in backend-ts/node_modules contract/node_modules; do
  [ -d "$REPO/$d" ] || { echo "refused: $d is not installed in this checkout" >&2; exit 2; }
done
[ ! -e "$AB" ] || { echo "refused: $AB exists (a previous recheck's trees); look at it and remove it first" >&2; exit 2; }
[ ! -e "$OUT" ] || { echo "refused: $OUT exists" >&2; exit 2; }
mkdir -p "$AB/base" "$AB/fix" "$OUT"
chmod 700 "$AB" "$OUT"
BATCH_START="$(stamp)"

extract() {   # extract <rev|WORKTREE> <dest>
  if [ "$1" = WORKTREE ]; then
    (cd "$REPO" && git ls-files -co --exclude-standard -z -- backend-ts contract | tar --null -T - -cf -) | tar -xf - -C "$2"
  else
    git -C "$REPO" archive "$1" backend-ts contract | tar -xf - -C "$2"
  fi
}
extract "$BASE_REV" "$AB/base"
extract "$FIX_REV" "$AB/fix"
BASE_SHA="$(git -C "$REPO" rev-parse "$BASE_REV^{commit}")"
if [ "$FIX_REV" = WORKTREE ]; then FIX_LABEL="worktree-on-$(git -C "$REPO" rev-parse HEAD)"; else FIX_LABEL="$(git -C "$REPO" rev-parse "$FIX_REV^{commit}")"; fi

# the fix tree is exactly what was measured; the base's journal.ts is the base's
while IFS='=' read -r f want; do
  got="$(sha_of "$AB/fix/$f")"
  [ "$got" = "$want" ] || { echo "refused: fix $f is not the measured file (sha256 $got)" >&2; exit 4; }
done <<< "$EXPECTED"
[ "$(sha_of "$AB/base/backend-ts/src/workspace/journal.ts")" = "$BASE_JOURNAL_SHA" ] || { echo "refused: the base journal.ts is not a4dc9ca's" >&2; exit 4; }
[ ! -e "$AB/base/$P" ] || { echo "refused: the base tree has its own scripts/perf_storage" >&2; exit 2; }
mkdir -p "$AB/base/$P"
for f in "${HARNESS[@]}"; do cp -p "$AB/fix/$P/$f" "$AB/base/$P/$f"; done
src_diff="$(diff -rq "$AB/base/backend-ts/src" "$AB/fix/backend-ts/src" | sed "s|$AB/||g" || true)"
[ "$src_diff" = "Files base/backend-ts/src/workspace/journal.ts and fix/backend-ts/src/workspace/journal.ts differ" ] || { printf 'refused: backend-ts/src differs beyond journal.ts:\n%s\n' "$src_diff" >&2; exit 4; }
diff -rq "$AB/base/contract" "$AB/fix/contract" >/dev/null || { echo "refused: contract/ differs between the trees" >&2; exit 4; }
for f in backend-ts/bun.lock backend-ts/package.json contract/bun.lock contract/package.json; do
  [ "$(sha_of "$AB/base/$f")" = "$(sha_of "$AB/fix/$f")" ] || { echo "refused: $f differs between the trees" >&2; exit 4; }
done

# the two generated entry points, each one line from its original, in each tree
generate() {   # generate <tree>
  python3 - "$AB/$1/$P" "$BENCH_FROM" "$BENCH_TO" <<'PY'
import sys
d, bench_from, bench_to = sys.argv[1], sys.argv[2], sys.argv[3]
def one_line(src, dst, match, make):
    lines = open(f"{d}/{src}", encoding="utf-8").read().split("\n")
    hits = [i for i, line in enumerate(lines) if match(line)]
    if len(hits) != 1:
        sys.exit(f"refused: {src}: {len(hits)} lines match, exactly 1 expected")
    lines[hits[0]] = make(lines[hits[0]])
    open(f"{d}/{dst}", "w", encoding="utf-8").write("\n".join(lines))
    return hits[0] + 1
n = one_line("file_journal_bench.ts", "file_journal_bench_spread5000.gen.ts", lambda l: l == bench_from, lambda l: bench_to)
if n != 31:
    sys.exit(f"refused: the scenario loop is on line {n}, not 31")
one_line("run.sh", "run_spread5000.gen.sh", lambda l: l.startswith("  journal) ") and l.count("bun_phase file_journal_bench.ts ") == 1,
         lambda l: l.replace("bun_phase file_journal_bench.ts ", "bun_phase file_journal_bench_spread5000.gen.ts "))
PY
  chmod 700 "$AB/$1/$P/run_spread5000.gen.sh"
}
generate base
generate fix
for g in file_journal_bench_spread5000.gen.ts run_spread5000.gen.sh; do
  [ "$(sha_of "$AB/base/$P/$g")" = "$(sha_of "$AB/fix/$P/$g")" ] || { echo "refused: generated $g differs between the trees" >&2; exit 4; }
done

for d in backend-ts/node_modules contract/node_modules; do
  for t in base fix; do cp -Rc "$REPO/$d" "$AB/$t/$d" 2>/dev/null || cp -R "$REPO/$d" "$AB/$t/$d"; done
done
for t in base fix; do
  [ "$(readlink "$AB/$t/backend-ts/node_modules/@oasis-code/contract")" = "../../../contract" ] || { echo "refused: the contract link in $t's node_modules is not the relative one" >&2; exit 4; }
done

{
  echo "kind=journal_spread_recheck (spread 5000 x 4096 only; frozen method, one-line selection)"
  echo "base_rev=$BASE_SHA"
  echo "fix_rev=$FIX_LABEL"
  echo "base_journal_ts_sha256=$(sha_of "$AB/base/backend-ts/src/workspace/journal.ts")"
  while IFS='=' read -r f want; do echo "verified_sha256 $f=$want"; done <<< "$EXPECTED"
  echo "recheck_script_sha256=$(sha_of "$HERE/journal_spread_recheck.sh")"
  echo "generated_sha256 file_journal_bench_spread5000.gen.ts=$(sha_of "$AB/fix/$P/file_journal_bench_spread5000.gen.ts")"
  echo "generated_sha256 run_spread5000.gen.sh=$(sha_of "$AB/fix/$P/run_spread5000.gen.sh")"
  echo "diff file_journal_bench.ts -> file_journal_bench_spread5000.gen.ts:"
  diff "$AB/fix/$P/file_journal_bench.ts" "$AB/fix/$P/file_journal_bench_spread5000.gen.ts" | sed 's/^/  /' || true
  echo "diff run.sh -> run_spread5000.gen.sh:"
  diff "$AB/fix/$P/run.sh" "$AB/fix/$P/run_spread5000.gen.sh" | sed 's/^/  /' || true
  echo "bun=$(bun --version)"
  printf 'batch_start\t%s\n' "$BATCH_START"
} > "$OUT/manifest.txt"
say "trees ready; manifest at \$OUT/manifest.txt"

run_in() {   # run_in <base|fix> <out subfolder> <script> <args...>
  local t="$1" sub="$2" script="$3"; shift 3
  local rev; if [ "$t" = base ]; then rev="$BASE_SHA"; else rev="$FIX_LABEL"; fi
  PERF_TMP_ROOT="$TMP_ROOT" PERF_OUT_DIR="$OUT/$sub" PERF_REVISION="$rev" "$AB/$t/$P/$script" "$@"
}

say "selftest"
run_in fix selftest run.sh selftest | tee "$OUT/selftest.txt"
grep -q 'expect allowed): refused\|expect refused): allowed' "$OUT/selftest.txt" && { echo "refused: the sandbox selftest failed" >&2; exit 5; }

printf 'round\tside\tposition\tstart_utc\tstart_mono_ns\tstart_load\tstart_free_bytes\tend_utc\tend_mono_ns\tend_load\tend_free_bytes\texit\n' > "$OUT/runs.tsv"
for round in 1 2 3; do
  if [ $((round % 2)) -eq 1 ]; then order="base fix"; else order="fix base"; fi
  pos=0
  for t in $order; do
    pos=$((pos + 1))
    say "round $round: $t"
    s="$(stamp)"
    rc=0; run_in "$t" "journal/large/r$round-$t" run_spread5000.gen.sh journal large || rc=$?
    e="$(stamp)"
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$round" "$t" "$pos" "$s" "$e" "$rc" >> "$OUT/runs.tsv"
    [ "$rc" -eq 0 ] || { echo "STOP: round $round $t exited $rc; the trees are kept for a look" >&2; exit 6; }
  done
done
printf 'batch_end\t%s\n' "$(stamp)" >> "$OUT/manifest.txt"

python3 "$AB/fix/$P/journal_grouping_ab_summary.py" --out "$OUT" > "$OUT/summary.md" || { echo "STOP: the undo counts differ between base and fix (summary.md); the trees are kept for a look" >&2; exit 7; }
# per matched pair: each round's base and fix p50 / p95, and fix/base - 1 of the p50
python3 - "$OUT" > "$OUT/paired.tsv" <<'PY'
import json, os, sys
out = sys.argv[1]
print("round\tread\tbase_p50\tfix_p50\tdelta_p50\tbase_p95\tfix_p95")
for r in (1, 2, 3):
    side = {t: json.load(open(os.path.join(out, "journal", "large", f"r{r}-{t}", "file_journal_bench_large.json")))["scenarios"] for t in ("base", "fix")}
    for read in ("folderChanges", "runChanges", "status", "diff"):
        b, f = side["base"][0][read]["ms"], side["fix"][0][read]["ms"]
        print(f"{r}\t{read}\t{b['p50']}\t{f['p50']}\t{f['p50'] / b['p50'] - 1:+.4f}\t{b['p95']}\t{f['p95']}")
    b, f = side["base"][0], side["fix"][0]
    print(f"{r}\tundoRun\t{b['undoRun']['ms']}\t{f['undoRun']['ms']}\t{f['undoRun']['ms'] / b['undoRun']['ms'] - 1:+.4f}\t\t")
    print(f"{r}\twrite\t{b['write_ms']['p50']}\t{f['write_ms']['p50']}\t{f['write_ms']['p50'] / b['write_ms']['p50'] - 1:+.4f}\t{b['write_ms']['p95']}\t{f['write_ms']['p95']}")
PY
leaks=0
for d in $(find "$OUT" -type d); do
  n="$(PERF_TMP_ROOT="$TMP_ROOT" PERF_OUT_DIR="$d" "$AB/fix/$P/run.sh" leakcheck | sed -E 's/.*: ([0-9]+) .*/\1/')"
  leaks=$((leaks + n))
done
echo "leakcheck_suspicious_lines=$leaks" >> "$OUT/manifest.txt"
say "leak check: $leaks suspicious line(s) (0 expected)"

# only the two trees made above are removed; the outputs stay
rm -rf "$AB/base" "$AB/fix"; rmdir "$AB"
say "done: \$OUT/summary.md, \$OUT/paired.tsv, \$OUT/runs.tsv"
