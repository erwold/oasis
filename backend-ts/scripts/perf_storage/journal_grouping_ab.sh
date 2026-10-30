#!/bin/bash
# Paired before/after of the FileJournal grouping fix, by one frozen method.
#
#   PERF_TMP_ROOT=<the task's temporary folder> [BASE_REV=<sha>] [FIX_REV=<sha>|WORKTREE] [ROUNDS=3] \
#     [SCALES="small large"] [EQUIV_SEEDS="20261018 7 424242"] journal_grouping_ab.sh
#
# 1. Two trees are extracted under PERF_TMP_ROOT: the base (BASE_REV, default main a4dc9ca) and the fix (FIX_REV, a
#    commit, or WORKTREE: this checkout's tracked and new files as they are). The harness (this folder) is the fix
#    tree's, copied into the base tree, so both run byte-identical scripts; the three files frozen from the storage
#    audit are checked against its SHA-256s. backend-ts/src must differ between the trees in
#    src/workspace/journal.ts only; contract/ and the lock files must be identical. Dependencies are cloned into both
#    trees from this checkout's installed node_modules (nothing is installed here).
# 2. Equivalence first: run.sh equiv in each tree, per seed; the digests of all the reads must be equal, or nothing is
#    timed.
# 3. Timing: run.sh journal <scale> (file_journal_bench.ts unchanged: its scenarios, warm-ups and samples —
#    PERF_SAMPLES is refused here so its default of 10 holds), ROUNDS paired rounds per scale, the order alternating
#    (base first in odd rounds, fix first in even ones). Each run's JSON is kept under its own name.
# 4. A summary (journal_grouping_ab_summary.py) and the leak check of every output; then the two extracted trees are
#    removed (only they: they were made here). Outputs stay under PERF_TMP_ROOT/journal-grouping-ab-out-<UTC time>.
#
# Run only in a measurement slot nothing else uses (the journal large scale writes about 0.5 GiB of synthetic data;
# 6 GiB must stay free).
set -euo pipefail

: "${PERF_TMP_ROOT:?PERF_TMP_ROOT must name the temporary folder of this task}"
[ -z "${PERF_SAMPLES:-}" ] || { echo "refused: PERF_SAMPLES is frozen at the bench's default (10); unset it" >&2; exit 2; }
TMP_ROOT="$(cd "$PERF_TMP_ROOT" && pwd -P)"
HERE="$(cd "$(dirname "$0")" && pwd -P)"
REPO="$(cd "$HERE/../../.." && pwd -P)"
case "$TMP_ROOT/" in "$REPO/"*) echo "refused: PERF_TMP_ROOT inside the checkout" >&2; exit 2;; esac
BASE_REV="${BASE_REV:-a4dc9ca3bfddfa9cc57b50ba5f68c914a5772d10}"
FIX_REV="${FIX_REV:-WORKTREE}"
ROUNDS="${ROUNDS:-3}"
SCALES="${SCALES:-small large}"
EQUIV_SEEDS="${EQUIV_SEEDS:-20261018 7 424242}"
AB="$TMP_ROOT/journal-grouping-ab"
OUT="$TMP_ROOT/journal-grouping-ab-out-$(date -u +%Y%m%dT%H%M%SZ)"
HARNESS=(file_journal_bench.ts common.ts guard_preload.ts journal_grouping_equivalence.ts journal_grouping_ab_summary.py run.sh)
# SHA-256 of the scripts the storage audit measured with (its batch 2 report; guard_preload.ts at 3232aa8)
FROZEN="file_journal_bench.ts=0a14f4cb45a91b96d62436650680b14663988dc3c1ce873c3db8ba21e57c4621
common.ts=6256511602fa422b9a99a91d42f3941af5bd88cde509b9b93b45301ecb2e71c6
guard_preload.ts=eac87505eb5fe518342ae8d5af755c23be9135c33508ca57f15f976857119141"

say() { printf '[ab] %s\n' "$*"; }
sha_of() { shasum -a 256 "$1" | cut -c1-64; }
free_gib() { df -k "$TMP_ROOT" | awk 'NR==2 {printf "%d", $4 / 1048576}'; }

[ "$(free_gib)" -ge 9 ] || { echo "refused: $(free_gib) GiB free; the A/B needs 3 GiB above the 6 GiB reserve" >&2; exit 3; }
for d in backend-ts/node_modules contract/node_modules; do
  [ -d "$REPO/$d" ] || { echo "refused: $d is not installed in this checkout (install it in the measurement slot first, as CI does: bun install --frozen-lockfile)" >&2; exit 2; }
done
[ ! -e "$AB" ] || { echo "refused: $AB exists (a previous A/B's trees); look at it and remove it first" >&2; exit 2; }
[ ! -e "$OUT" ] || { echo "refused: $OUT exists" >&2; exit 2; }
mkdir -p "$AB/base" "$AB/fix" "$OUT"
chmod 700 "$AB" "$OUT"

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

# the harness: the fix tree's, in both; the frozen files as the audit measured them
[ ! -e "$AB/base/backend-ts/scripts/perf_storage" ] || { echo "refused: the base tree has its own scripts/perf_storage" >&2; exit 2; }
mkdir -p "$AB/base/backend-ts/scripts/perf_storage"
for f in "${HARNESS[@]}"; do cp -p "$AB/fix/backend-ts/scripts/perf_storage/$f" "$AB/base/backend-ts/scripts/perf_storage/$f"; done
while IFS='=' read -r f want; do
  got="$(sha_of "$AB/fix/backend-ts/scripts/perf_storage/$f")"
  [ "$got" = "$want" ] || { echo "refused: $f is not the audit's (sha256 $got)" >&2; exit 4; }
done <<< "$FROZEN"
for f in "${HARNESS[@]}"; do
  [ "$(sha_of "$AB/base/backend-ts/scripts/perf_storage/$f")" = "$(sha_of "$AB/fix/backend-ts/scripts/perf_storage/$f")" ] || { echo "refused: harness $f differs between the trees" >&2; exit 4; }
done

# what differs between the trees: journal.ts only (plus this branch's own test and harness, which are not src)
src_diff="$(diff -rq "$AB/base/backend-ts/src" "$AB/fix/backend-ts/src" | sed "s|$AB/||g" || true)"
[ "$src_diff" = "Files base/backend-ts/src/workspace/journal.ts and fix/backend-ts/src/workspace/journal.ts differ" ] || { printf 'refused: backend-ts/src differs beyond journal.ts:\n%s\n' "$src_diff" >&2; exit 4; }
diff -rq "$AB/base/contract" "$AB/fix/contract" >/dev/null || { echo "refused: contract/ differs between the trees" >&2; exit 4; }
for f in backend-ts/bun.lock backend-ts/package.json contract/bun.lock contract/package.json; do
  [ "$(sha_of "$AB/base/$f")" = "$(sha_of "$AB/fix/$f")" ] || { echo "refused: $f differs between the trees" >&2; exit 4; }
done

# dependencies: one installed set, cloned (APFS copy-on-write where it can) into both trees
for t in base fix; do
  for d in backend-ts/node_modules contract/node_modules; do cp -Rc "$REPO/$d" "$AB/$t/$d" 2>/dev/null || cp -R "$REPO/$d" "$AB/$t/$d"; done
  [ "$(readlink "$AB/$t/backend-ts/node_modules/@oasis-code/contract")" = "../../../contract" ] || { echo "refused: the contract link in $t's node_modules is not the relative one bun's postinstall makes" >&2; exit 4; }
done

{
  echo "base_rev=$BASE_SHA"
  echo "fix_rev=$FIX_LABEL"
  echo "fix_journal_ts_sha256=$(sha_of "$AB/fix/backend-ts/src/workspace/journal.ts")"
  echo "base_journal_ts_sha256=$(sha_of "$AB/base/backend-ts/src/workspace/journal.ts")"
  for f in "${HARNESS[@]}"; do echo "harness_sha256 $f=$(sha_of "$AB/fix/backend-ts/scripts/perf_storage/$f")"; done
  echo "bun=$(bun --version)"
  echo "rounds=$ROUNDS scales=$SCALES equiv_seeds=$EQUIV_SEEDS"
  echo "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT/manifest.txt"
say "trees ready; manifest at \$OUT/manifest.txt"

run_in() {   # run_in <base|fix> <out subfolder> <run.sh args...>
  local t="$1" sub="$2"; shift 2
  local rev; if [ "$t" = base ]; then rev="$BASE_SHA"; else rev="$FIX_LABEL"; fi
  PERF_TMP_ROOT="$TMP_ROOT" PERF_OUT_DIR="$OUT/$sub" PERF_REVISION="$rev" "$AB/$t/backend-ts/scripts/perf_storage/run.sh" "$@"
}

say "selftest"
run_in fix selftest selftest | tee "$OUT/selftest.txt"
grep -q 'expect allowed): refused\|expect refused): allowed' "$OUT/selftest.txt" && { echo "refused: the sandbox selftest failed" >&2; exit 5; }

say "equivalence"
for seed in $EQUIV_SEEDS; do
  for t in base fix; do PERF_EQUIV_SEED="$seed" run_in "$t" "equiv/$t" equiv; done
  b="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["digest"])' "$OUT/equiv/base/journal_grouping_equivalence_$seed.json")"
  f="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["digest"])' "$OUT/equiv/fix/journal_grouping_equivalence_$seed.json")"
  if [ "$b" != "$f" ]; then
    echo "STOP: seed $seed: the reads differ between base and fix (rerun that seed with PERF_EQUIV_KEEP_CANONICAL=1 and compare the canonical files); nothing is timed" >&2
    exit 6
  fi
  say "seed $seed: equal ($b)"
done

say "timing"
for scale in $SCALES; do
  for round in $(seq 1 "$ROUNDS"); do
    if [ $((round % 2)) -eq 1 ]; then order="base fix"; else order="fix base"; fi
    for t in $order; do
      say "$scale round $round: $t"
      run_in "$t" "journal/$scale/r$round-$t" journal "$scale"
    done
  done
done

python3 "$AB/fix/backend-ts/scripts/perf_storage/journal_grouping_ab_summary.py" --out "$OUT" > "$OUT/summary.md" || { echo "STOP: the undo counts differ between base and fix (summary.md); the trees are kept for a look" >&2; exit 7; }
echo "finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT/manifest.txt"
leaks=0
for d in $(find "$OUT" -type d); do
  n="$(PERF_TMP_ROOT="$TMP_ROOT" PERF_OUT_DIR="$d" "$AB/fix/backend-ts/scripts/perf_storage/run.sh" leakcheck | sed -E 's/.*: ([0-9]+) .*/\1/')"
  leaks=$((leaks + n))
done
echo "leakcheck_suspicious_lines=$leaks" >> "$OUT/manifest.txt"
say "leak check: $leaks suspicious line(s) (0 expected)"

# only the two trees made above are removed; the outputs stay
rm -rf "$AB/base" "$AB/fix"; rmdir "$AB"
say "done: \$OUT/summary.md"
