#!/usr/bin/env bash
# The affected e2e files, one node --test process each, one after another, all on port 8399 (OASIS_CODE_E2E_PORT).
# Before each file: wait until nothing listens on 8399 (never stop what does). Each file's output and exit code go to
# <logdir>/e2e-<file>.log and <logdir>/e2e-summary.tsv. Run from frontend/ after `npm run build`.
#   scripts/run-e2e-serial.sh <logdir> file1.e2e.ts [file2.e2e.ts …]
set -u
logdir="$1"; shift
mkdir -p "$logdir"
summary="$logdir/e2e-summary.tsv"
[ -f "$summary" ] || printf 'file\texit\tstarted\tfinished\tseconds\tpid\n' > "$summary"
port_busy() { lsof -nP -iTCP:8399 -sTCP:LISTEN >/dev/null 2>&1; }
for f in "$@"; do
  waited=0
  while port_busy; do
    [ $waited -eq 0 ] && echo "8399 is in use; waiting (nothing is stopped)" | tee -a "$logdir/e2e-$f.log"
    sleep 5; waited=$((waited + 5))
  done
  start=$(date +%s); started=$(date -u +%FT%TZ)
  echo "== $f (started $started)" | tee -a "$logdir/e2e-$f.log"
  OASIS_CODE_E2E_PORT=8399 node --test --test-concurrency=1 "e2e/$f" >> "$logdir/e2e-$f.log" 2>&1 &
  pid=$!
  echo "pid $pid" >> "$logdir/e2e-$f.log"
  wait $pid; code=$?
  end=$(date +%s)
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$f" "$code" "$started" "$(date -u +%FT%TZ)" "$((end - start))" "$pid" >> "$summary"
  echo "== $f exit $code ($((end - start)) s)" | tee -a "$logdir/e2e-$f.log"
  # the file's own servers are gone before the next one starts
  for _ in 1 2 3 4 5 6; do port_busy || break; sleep 5; done
done
