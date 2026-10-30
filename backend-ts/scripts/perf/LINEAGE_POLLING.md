# Lineage polling: one process-table reading per tick for all running commands

Measured 2026-10-18 (UTC) on macOS arm64 (Apple M4 Pro, 12 cores), Bun 1.4.0. Base commit
`a4dc9ca3bfddfa9cc57b50ba5f68c914a5772d10`. Raw results, with host paths replaced: `results/lineage_polling_ab.json`.

## The change (`src/execution/processes.ts`)

Before, every running command's watch read the whole kernel process table (`identities()`: `proc_listallpids`, then
one `proc_pidinfo` per readable pid) every 50 ms. Ten commands meant about 193 table readings per second.

Now the watches of all running commands wait for one shared lineage tick, every 50 ms. The tick reads the table once,
fresh, for every waiting command whose process still runs, and reads it into each one's lineage.

- **The tick's timer** is made by the first watch that waits and exists only while a watch waits. A command whose
  process has exited leaves the tick; the last one out clears its timer.
- **A failed reading belongs to exactly one command.** A reading that throws is the failure of the first waiting
  command it was made for: that watch alone fails on its existing failure path. The table is then read again, fresh,
  for the remaining waiting commands, and the next failure, if any, belongs to the next of them. Nothing is dropped,
  nothing is broadcast to all waiting commands, nothing is thrown out of the timer.
- **Unchanged:**
  - **The 50 ms cadence.** A new command joins the tick already pending, so its first check can come sooner than 50 ms, never later.
  - **Absolute deadlines.** Each tick still compares against the deadline, and the group is killed right after that tick's fresh reading.
  - **Stop.** `stop()` still kills the process group immediately and does not wait for a tick.
  - **Process exit.** When the exit wins the race, the watch reads a table of its own, made then.
  - **`reapStrays`.** Still reads a fresh table every round.
  - **Commands without a known lineage.** The table is still read for them, as before.
  - Also unchanged: the fork watcher and its fallback, the PID-reuse checks by unique id, logs, events and output.
- **The existing watch failure path is kept as it was.** A watch whose reading failed ends through the catch in
  `launch`. Its process keeps running until stopped, and its entry stays in the live map. Its fork-watch registration
  is never removed either, since that removal is only on the normal path. The regression tests check that after Stop
  no command runs and no tick is pending; they do not claim that the live map is emptied on that path.

## Regression tests (`tests/test_lineage_tick.test.ts`, 5 tests, macOS)

1. Five running commands: every tick reads the table exactly once for all five, and nothing else reads it. A stopped
   one gets a fresh reading of its own after its exit, and later ticks never include it. No tick is pending once the
   last command has exited, and no further readings happen.
2. With the fork watcher kept out, the tick alone finds the child of a short-lived intermediate. Stop takes that child
   after the intermediate is gone.
3. Commands stopped, timed out and left running side by side: each takes only the processes it made, and a bystander
   process is untouched.
4. One injected reading failure among three commands: exactly one watch fails on its existing path. That is the first
   command of the failed reading. The other two are read again at once and go on. No later reading includes the
   failed command.
5. Two injected reading failures: exactly two watches fail, each on its own path, and the third goes on.

Every assertion is on counts and on which processes live. A wait only waits for a condition and is bounded; nothing
asserts on elapsed time.

## Method

- **Harness.** `bench_lineage.ts` with the preload `lib/lineage_probe.ts`, run by `run_lineage_ab.ts`. It uses the
  perf app from the frozen audit harness (`lib/*.ts`, `bench_watches.ts`, copied byte for byte from commit
  `2f5098a4f9e2d99d16356948d16d739e64467e46`). The quiet commands are `perl` sleeping, run in sandbox mode through the
  test suite's passthrough runtime. No watches. Each window is 30 s, measured after a 0.5 s settle.
- **Two counters, kept apart.**
  - Calls of the manager's `trackLineage`, counted with an instance wrapper.
  - Actual whole-table readings, from the probe. The probe rewrites `lineage.ts` at load time to wrap `identities()`
    only: count, time and rows returned, with nothing per pid. Its scope is the main thread. The fork-watch worker is
    not wrapped, and it never reads the whole table.
  - If the rewrite is not loaded, the bench refuses to run. If a command ran its whole window and no reading was
    counted, the bench refuses to write a result.
  - CPU is the bench process's user+system time over the window, and **includes the probe**.
- **Pairing.**
  - The baseline is the base commit's own `processes.ts`, swapped into the same worktree for that pass only. It is
    put back and verified byte for byte after each pass.
  - Every other production file equals the base; this was checked before the run.
  - Order: baseline → after → baseline → after. Each pass is one fresh process covering 0/1/5/10 commands, rounds 1.
- **Orchestration.** The formal run was driven by a host-specific script that is not shipped (sha256
  `5cb4e68806eb7e75e84640eefc1c70d6eda15535395f66ed7f7ef6789d135689`, kept with the run's evidence). Its stages:
  1. A host `ps` check.
  2. The targeted tests.
  3. The 2 s smoke of the probe.
  4. The A/B.
  5. A check that no quiet command was left.

## Stage outcomes (formal run, 2026-10-18T16:57:43.893Z → 17:07:10.989Z, driver exit 0)

| stage | exit | UTC | result |
|---|---|---|---|
| host `ps` | 0 | 16:57:43.895–.921 | 1242 processes listed, including the driver itself |
| targeted tests (5 files) | 0 | 16:57:43.921–16:58:37.476 | 39 tests, 405 assertions, 0 failures, 0 errors, 0 skipped (53.55 s) |
| smoke (after, 2 s) | 0 | 16:58:37.476–16:58:44.434 | 0 commands: 0 readings. 1 command: 39 readings (19.5/s), 1243 rows per reading |
| A/B | 0 | 16:58:44.435–17:07:10.935 | 4 passes exit 0, each validated. Every swap and restore was verified |
| leftover quiet commands | 0 | 17:07:10.935–.989 | none left |

The targeted test files were `test_lineage_tick`, `test_processes`, `test_fork_watch_record`, `test_fork_watcher` and
`test_process_scratch_lifecycle`.

Passes:
- `01_baseline` 16:58:44.496–17:00:50.901
- `02_after` 17:00:50.902–17:02:57.425
- `03_baseline` 17:02:57.426–17:05:04.047
- `04_after` 17:05:04.048–17:07:10.932

## Sources and harness (sha256)

| file | sha256 |
|---|---|
| `processes.ts`, baseline (git blob `c86ecced…`) | `bf472cac37aaf3b12313d98daf6e20efad958cc471c02a0089ee90171a8e6c22` |
| `processes.ts`, after (git blob `4dcf34ad…`) | `7e2ed52849c2e96bc7f6665463b340381cb67983b5ee120b5f056ab2c41fa994` |
| `lineage.ts` (unchanged) | `523cea7bf9f0d25a2cd588bc7972b731f02b36705b39826fd64e45979705b21e` |
| `bench_lineage.ts` | `128cf5c96300f001ef969c96c23a61893e79e303fd65a1742a17a5b4f8ba38c8` |
| `lib/lineage_probe.ts` | `fb7013fea560fd78edf648c0bcb9257a59d1d9e32b5894b77751764f91b44f50` |
| `run_lineage_ab.ts` | `678320a859614b793a62768aea3954f705442d78dd2aa5e828bf251d1ea548f0` |
| `bench_watches.ts` (frozen) | `e6644ad0ba01a10e2e43a347f99a665096f00925cd5a76165c05b054d89a76f3` |
| `lib/app.ts` (frozen) | `0e8215511b8e0577bcf8ec2e1c7a008095a66ed87f1c3a4f5b6a667e437f9521` |
| `lib/env.ts` (frozen) | `207a78cac0cf5c172ef4680301850578191d151cea4d142db1bc8c5403d3289a` |
| `lib/fixtures.ts` (frozen) | `67322f3da3e2cacaa53fe24d4722452c371827166f20bcc8d3f1876171075b5f` |
| `lib/stats.ts` (frozen) | `27fb3ad7fee2dc04dee3cb9031f32ff55644cb54728415c78342000246047816` |
| `tests/test_lineage_tick.test.ts` | `e50d89e2c3d94e1d21173875ee50c834cb35e439edf4b5ce786218abf34305c5` |

## Raw samples (30 s windows)

| pass | n | CPU % of one core | readings/s | reading ms total | ms per reading | rows per reading | `trackLineage` calls/s | host processes before→after | load before→after |
|---|---|---|---|---|---|---|---|---|---|
| 01 baseline | 0 | 0.266 | 0 | 0 | – | – | 0 | 1243→1245 | 4.81→6.37 |
| 01 baseline | 1 | 3.135 | 19.3 | 460.3 | 0.794 | 1246.2 | 19.3 | 1246→1249 | 6.37→6.23 |
| 01 baseline | 5 | 8.133 | 96.7 | 1528.7 | 0.527 | 1249.6 | 96.7 | 1250→1254 | 6.23→5.19 |
| 01 baseline | 10 | 14.582 | 193.0 | 2945.0 | 0.509 | 1255.0 | 193.0 | 1263→1260 | 5.50→5.16 |
| 02 after | 0 | 0.170 | 0 | 0 | – | – | 0 | 1259→1263 | 5.16→4.11 |
| 02 after | 1 | 3.540 | 19.3 | 542.2 | 0.936 | 1247.6 | 19.3 | 1264→1243 | 4.11→3.95 |
| 02 after | 5 | 4.247 | 19.2 | 659.7 | 1.145 | 1246.6 | 19.2 | 1247→1247 | 4.35→3.78 |
| 02 after | 10 | 3.525 | 19.3 | 459.9 | 0.793 | 1250.7 | 19.3 | 1252→1256 | 3.78→3.81 |
| 03 baseline | 0 | 0.287 | 0 | 0 | – | – | 0 | 1251→1249 | 3.81→4.35 |
| 03 baseline | 1 | 3.759 | 19.3 | 596.2 | 1.031 | 1248.3 | 19.3 | 1250→1251 | 4.40→3.85 |
| 03 baseline | 5 | 9.437 | 96.5 | 1820.5 | 0.629 | 1253.1 | 96.5 | 1251→1253 | 3.85→3.85 |
| 03 baseline | 10 | 15.528 | 192.7 | 3235.0 | 0.560 | 1253.3 | 192.7 | 1258→1253 | 3.85→4.67 |
| 04 after | 0 | 0.211 | 0 | 0 | – | – | 0 | 1251→1273 | 5.02→6.07 |
| 04 after | 1 | 3.345 | 19.3 | 546.6 | 0.946 | 1272.0 | 19.3 | 1274→1277 | 6.07→7.44 |
| 04 after | 5 | 3.647 | 19.3 | 542.9 | 0.939 | 1278.0 | 19.3 | 1281→1277 | 7.44→6.33 |
| 04 after | 10 | 4.353 | 19.2 | 635.7 | 1.106 | 1282.6 | 19.2 | 1281→1293 | 6.22→7.12 |

Load is the 1-minute load average, taken around each window. Each pass file's `loadavg_start` and `at` are taken when
its result is written, at the end of the pass, so they are not start values.

## Two-pass summary: median and range, n = 2 per condition

No confidence claim is made from two samples per condition.

| n | metric | baseline median [range] | after median [range] | change |
|---|---|---|---|---|
| 10 | CPU % of one core | 15.055 [14.582–15.528] | 3.939 [3.525–4.353] | −11.116 pp (−73.8 %); per pair −11.057, −11.175 pp |
| 10 | table readings/s | 192.85 [192.7–193.0] | 19.25 [19.2–19.3] | −90.0 % |
| 10 | reading ms per 30 s | 3090.0 [2945.0–3235.0] | 547.8 [459.9–635.7] | −82.3 % |
| 5 | CPU % of one core | 8.785 [8.133–9.437] | 3.947 [3.647–4.247] | −4.838 pp (−55.1 %); per pair −3.886, −5.790 pp |
| 5 | table readings/s | 96.6 [96.5–96.7] | 19.25 [19.2–19.3] | −80.1 % |
| 5 | reading ms per 30 s | 1674.6 [1528.7–1820.5] | 601.3 [542.9–659.7] | −64.1 % |
| 1 | CPU % of one core | 3.447 [3.135–3.759] | 3.4425 [3.345–3.540] | −0.005 pp: no measured gain; per pair **+0.405**, −0.414 pp |
| 1 | table readings/s | 19.3 | 19.3 | none (one command, one reading per tick, before and after) |
| 0 | CPU % of one core | 0.2765 [0.266–0.287] | 0.1905 [0.170–0.211] | no readings either way; not attributable to the change |

Notes:
- **A single command gains nothing.** It already made one reading per tick, and one pair was slower after (+0.405 pp).
- **Per-reading time was higher in the after passes** (0.79–1.15 ms against 0.51–1.03 ms baseline) while readings/s
  fell 5–10×. This was observed, not explained. The reading ms total per window is the figure that counts the table
  work.
- **`trackLineage` calls/s equal readings/s in every window here.** No reading failed, so each call made exactly one
  reading. The readings are still counted by the probe, not inferred from the calls.
- **The host was not idle.** The 1-minute load was 3.8–7.4 during the A/B. Rows per reading were 1246–1283 and host
  processes 1243–1293, drifting upward in the last pass.
- **First-pass numbers from earlier audit runs, made with a heavier probe, are not used here.**

## Running it again

From `backend-ts/`, with dependencies installed:

```
bun scripts/perf/run_lineage_ab.ts smoke --out <new folder under the system temp dir>
bun scripts/perf/run_lineage_ab.ts ab --out <new folder under the system temp dir>
```

Before anything runs, it refuses another Bun than 1.4.0, a host other than macOS, a production difference from the
base other than `processes.ts`, and an output folder inside the repository or `~/.oasis-code`. Every pass is its own
process. To run the bench alone:

```
bun --preload ./scripts/perf/lib/lineage_probe.ts scripts/perf/bench_lineage.ts --commands 0,1,5,10 --window-s 30 --out <dir>
```
