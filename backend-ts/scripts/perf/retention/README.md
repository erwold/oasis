# Completed-run retention: what a finished run keeps in memory

## The change (`src/agent/runner.ts`, +7/−3)

- `RunHandle.stash_json` is gone. It was a second, serialized copy of the run's record, written on every progress
  save and never read anywhere in `src/`. The record itself is still written to the database as before
  (`repo.saveRunProgress`, `repo.finishRun`).
- `finalize()` sets `handle.meter = null` as its last step: after the receipt, `repo.finishRun`, `run_finished`,
  `done = true`, the subscriber sentinels and the finish hooks. A finished run's meter was holding the run's whole
  model chain and the callbacks it captured. Only a live run reads the meter (`spent()`, i.e. `limits()`,
  `budgetLine()`, `checkBudget()`); what is read after the end (usage, receipt, model requests, context anchor) is
  read from the database. If `finishRun` throws, `done` stays false and the meter is kept, as before.
- The meter is never closed: its model wraps the route's shared provider, which other runs still use.
- Handles, their events (saved and transient), `task`, the queues and the finish hooks are unchanged. A finished
  handle still answers late run streams, the events page, the session replay and Stop as before.

## Results (formal A/B, `results/`)

One worktree, one harness (below), one fresh process per stage, run in the order before-long, before-mixed,
after-long, after-mixed. "before" is the base `runner.ts` (git blob `70c282c3cfa782a27956b18ac1fc8843b71c6039`,
from `a4dc9ca3bfddfa9cc57b50ba5f68c914a5772d10`); "after" is this change (blob
`3cba8b1d0855f3a6209c9a4612c0dd36d8bde44c`). Every other file was identical in both states. Bun 1.4.0, darwin
arm64 (Apple M4 Pro, 12 cores, 48 GB). Heap figures are JSC heap after full GC, taken by the harness.

| stage | start → end (UTC, 2026-10-18) | whole command (monotonic) | exit |
|---|---|---|---|
| before-long | 15:37:42.935 → 15:37:54.060 | 11.123 s | 0 |
| before-mixed | 15:37:54.158 → 15:39:16.762 | 82.601 s | 0 |
| after-long | 15:39:16.865 → 15:39:27.027 | 10.162 s | 0 |
| after-mixed | 15:39:27.121 → 15:40:50.320 | 83.198 s | 0 |

### long: a 500-turn synthetic record, continued 2 + 20 times

`--long-history 500 --long-runs 20 --long-warmup 2 --window 2000000`: a seed run whose record is replaced by a
synthetic one of 500 turns with 3 tool calls each (about 3.8 MB of JSON), then 22 successful continuations (2
warm-up, 20 measured). The 2M-token window keeps any compaction from triggering. This is a coverage scenario, not
the app's default configuration, and its numbers do not carry over to it.

| | before | after |
|---|---|---|
| heap at measured run 0 → 20 | 135.03 → 635.89 MiB (+500.86) | 85.03 → 85.89 MiB (+0.86) |
| retained `stash_json` at run 20 | 84.57 MiB | 0 |
| JSC objects, run 0 → 20 | 861,511 → 1,339,071 | 815,158 → 835,180 |

Identical in both states: 22 runs done, 0 compactions, handles 3 → 23, handle events 24 → 184 (transient 12 → 92),
live run queues 0, session queues 1, FDs 14 throughout.

Heap at run 0 is already about 50 MiB higher before, because the seed run and the 2 warm-up runs already hold
their stash and meter graph by then.

The harness's counterfactual attribution only runs inside the bench process, after every fingerprint was taken, and
says what each field held, not a per-run slope.
- before: clearing the finished handles' meter graph (the `meter.emit` step) freed 356.87 MiB, and clearing
  `stash_json` freed 193.06 MiB.
- after: 3.52 MiB in all could still be freed, 3.4 MiB of it `tool_snapshot`.

### mixed: 300 short runs

`--runs 300 --warmup 30 --sample 25`: 300 runs in all, the 30 warm-up runs included; the trend is fitted over the
270 runs after warm-up. Both states: 100 done, 100 error (HTTP 400 from the stub), 100 cancelled.

| | before | after |
|---|---|---|
| heap slope over runs 30 → 300 | 0.11658 MiB/run (R² 0.994) | 0.03931 MiB/run (R² 0.948) |
| heap at run 300 | 108.74 MiB | 85.14 MiB |
| objects slope | 1,843 /run | 739 /run |

Identical in both states, and still growing:
- handles +1/run (300 at the end), handle events +5/run (1,500), transient events +1.33/run (400);
- FDs and queues flat (FD 14).

This change does not stop handles and events from accumulating. A residual heap slope of 0.039 MiB/run remains.

### What these results do not claim

- No speed claim. Each state has a single whole-command observation per scenario, which is not enough to conclude
  anything about speed.
- No RSS claim. Mixed RSS at run 300 was 904.2 MiB before and 1006.81 MiB after, and long RSS grew +495.45 MiB
  before and +222.89 MiB after; RSS follows the allocator and GC, not the live heap.
- Nothing about the app's default configuration or real workloads.

## Behaviour checks

### Regression tests

`tests/test_completed_run_retention.test.ts` (5 tests) and one added test in `tests/test_workspace_queue.test.ts`.
They cover a run that completes, a provider failure (401), a Stop during a request, a budget line (with and without
the closing report), a queued run stopped in line, and a run on the same route still live while another finishes.

Together these tests cover the following; not every assertion is made in every test (the source shows which test
checks what):
- Structure: each terminal path checks that the finished handle stays, done, with its events and no meter; the
  tests in `test_completed_run_retention.test.ts` and the queued (stopped) run also check its task and that it has no
  `stash_json` (for the queue holder only its meter and events are checked). The shared-route test and the
  queued-run test check that a run still live keeps its meter; the tests in `test_completed_run_retention.test.ts`
  check that the route's model (counting its close calls) is never closed.
- What the run wrote: the record, the usage (requests, tokens, tool calls, history bytes), `context_anchor`, the
  model requests, the receipt. The exact token, anchor and model-request values are checked in the completed-run
  test; the other tests check the fields their path determines.
- What it answers: `GET /api/runs/:id` and `/receipt` equal the database row (all tests in
  `test_completed_run_retention.test.ts`; the queued-run test compares the stopped run's status, receipt and usage);
  the transcript and the session context report (anchored on the run's count) in the completed-run test.
- Its events: the late run stream is deep-equal to the live one; the run SSE and the events page are equal to it,
  payloads included; the saved rows and the session replay frames are equal to the live event of the same seq (the
  queued-run test checks the stopped run's late stream, SSE, page and saved rows, and the holder's late stream and
  saved rows, without the session replay).
- The next run continues the record (the completed-run test).

Run on this machine (`bun test --timeout 60000`, JUnit reporter; the two files together, 21 tests):
- Round 1: 20 pass, 1 fail, 0 skip, exit 1. The test's own expectation was wrong: when a closing turn calls a tool
  anyway, that call counts as a call (`usage.tool_calls` 3, 2 tool results), as `test_runner` already holds.
- Round 2: the same file, the edit not yet applied; the same result.
- Round 3: after correcting that expectation to the existing semantics, 21 pass, 0 fail, 0 skip, exit 0.

`bun run typecheck` exited 0 with the harness in `scripts/perf` (in the tsconfig).

### Fingerprints (`results/fingerprint_diagnosis.json`; diagnosis only, not performance samples)

The harness fingerprints a finished run's reads after normalizing ids, times, hashes and its temp root. In the
formal A/B the last run's `GET /api/runs/:id` hash differed (`adab4d45f26ca1c5` → `b0809c1db751b57f`). So did hashes
of the seed run and of the session replay.

Two diagnostic runs set `PERF_FP_DUMP`, which makes the frozen harness write the exact text it hashes, and compared
those texts field by field:
- short: 2 + 2 continuations, before/after/before/after in 4 processes;
- full: the formal long parameters, before/after in 2 processes.

All 6 stages exited 0. Findings:

- The last run's GET differs only in `manifest.build.source_fingerprint` (`d494b571514a` → `1119cfa2cce9`). That
  field is a hash of the backend's source files (`src/version.ts`), so it changes with any change to `runner.ts`;
  it identifies the build. The full run reproduced the formal hashes `adab4d45f26ca1c5` → `b0809c1db751b57f`
  exactly. The field is left as is, not normalized away.
- The seed run's GET differs in the same field and in `requests[0].context_estimate_tokens`:
  - short before pair: 11793 and 11788 (the two before processes differ);
  - short after pair: 11790 and 11790;
  - full: 11793 before, 11790 after.

  That number is the context keeper's estimate for the seed run's first request, the whole prompt counted with a
  tokenizer (no provider count to anchor on yet). The exact cause of the variation (11793, 11788, 11790) is not
  established: the complete, un-normalized request input was not kept, and the dumps only show the normalized text.
  The code suggests a lead, no more: the first prompt can carry values that change from process to process (random
  ids, the workspace path under the data root, the temporary folder), whose token count can differ. Because the
  value varied between two processes of the same code, it is not attributed to this change; it is not normalized
  away either.
- Everything else is identical, payloads compared field by field, between before and after in both diagnostic runs
  (and within each pair of the same state):
  - the seed and last records;
  - the run SSE and the events page (8 frames each for each run, in both runs);
  - the transcripts;
  - the session replay, with the same frame count and event-type counts within each run: 41 frames in the short
    run (5 runs in the session: seed, 2 warm-up, 2 measured) and 185 frames in the full run (23 runs: seed, 2
    warm-up, 20 measured); both counts include the `stream_ready` frame.
- Limits:
  - The formal A/B ran without `PERF_FP_DUMP`, so the texts behind its hashes were not kept.
  - Its seed SSE, page and session-replay differences did not occur in either diagnostic run, and their cause cannot
    be recovered.
  - The last record's hash in the full diagnostic pair (`f2e1cad02fd2f302`) is the same before and after, but
    differs from the formal pair's (`b8fb205dd9ae8683`), with the same byte count; that is not explained either.
  - So not every fingerprint has been shown identical.

## Harness and method

The harness is `scripts/perf/bench_lifecycle.ts` and its import closure `lib/app.ts`, `lib/env.ts`,
`lib/fixtures.ts`, `lib/stats.ts`. They are copied from the performance audit's commit
`2f5098a4f9e2d99d16356948d16d739e64467e46`; the other files of that audit stay on its own branch.

Four of the files are byte-identical to the audit's. `bench_lifecycle.ts` adds a type-only view,
`type LegacyStash = { stash_json?: string | null }`. Every read of `h.stash_json` (four, in two
expressions) reads `(h as unknown as LegacyStash).stash_json`, so that it typechecks without the removed field;
the JavaScript it runs reads the same property (undefined, counted as 0, after the change).

sha256 of the five files (manifest `d5692a6a6fc8bb82980702498d55e36a296019cfdb7a12f8060fa2a7a7c6fb3b`):

```
49b40324ccf835ec682b2fd1be2d74b5fadda57256db8326649c29ac212d228a  bench_lifecycle.ts   (audit: 4d7ea48c2abe338bf0d935175ba8c18092d26833dee43a2fe904528e00ac3f33)
0e8215511b8e0577bcf8ec2e1c7a008095a66ed87f1c3a4f5b6a667e437f9521  lib/app.ts
207a78cac0cf5c172ef4680301850578191d151cea4d142db1bc8c5403d3289a  lib/env.ts
67322f3da3e2cacaa53fe24d4722452c371827166f20bcc8d3f1876171075b5f  lib/fixtures.ts
27fb3ad7fee2dc04dee3cb9031f32ff55644cb54728415c78342000246047816  lib/stats.ts
```

`ab_lifecycle.sh` (with `timed_run.py`) is a portable version of the wrapper, for reproducing the method. It runs
the four stages:
- It checks the five hashes, the manifest and the timer before every process.
- It puts the base `runner.ts` in place by its git blob, and puts the checked-out one back by a trap on any exit,
  INT or TERM included.
- It records each stage's real exit status, its start/end UTC and the monotonic elapsed of the whole bun command;
  `timed_run.py` takes both readings in one Python process around one subprocess, so the figure includes bun's
  start and exit.
- It exits non-zero if any stage failed or the restore did not hold.

This committed version has only been checked with `bash -n`; it has not been run. The formal A/B was run with the
original external wrapper (sha256 `7a9aecadb418e72eb7057d72cdf52dc9f004b3eb58674c83071d8d08d19afa07`, with
`timed_run.py` sha256 `ac67e3d20f85e2e87125182fcfd39069f22ef2bd59fc351dd43d15e32072912e`, the same file as the one
committed here). The committed wrapper differs from it in:
- deriving the repository paths from its own location instead of fixed local absolute paths;
- not checking that `scripts/perf` holds no other files than the five (it checks the five files' hashes only);
- letting `BASE` be overridden from the environment, where the original fixed the base commit and checked the base
  runner blob against `70c282c3cfa782a27956b18ac1fc8843b71c6039`;
- writing placeholders instead of full paths in its records, and requiring `AB_ROOT` to be set.

None of these changes what the harness runs.

Usage on a checkout of this branch:

```sh
AB_ROOT=<new folder> SYS_TMPDIR="$TMPDIR" bash backend-ts/scripts/perf/retention/ab_lifecycle.sh
```

`results/*.json` are the harness's outputs with only the `--out` path replaced by `<ab-root>`. `results/stages.json`
holds each stage's record and the sha256 of every output as the harness wrote it.

### Attempts that did not count

- A first A/B attempt failed in all 4 stages (exit 1 each, about 0.1 s each, nothing measured). The harness refused
  its data root because the per-stage TMPDIR was inside the app's data directory. Each stage's TMPDIR was moved
  under the system temp folder; nothing else changed.
- Process listing (`ps`) was refused by the sandbox the work ran in. That the measuring processes had ended rests
  on the wrapper having waited for each subprocess's exit, not on a process scan.

## Still pending

The full backend suite, the frontend tests, the 20 end-to-end files and CI have not been run on this commit; this
commit is not a gate pass. A change to the source or the tests made for those gates needs a new SHA and both sides
measured again.
