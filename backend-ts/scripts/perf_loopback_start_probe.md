# SSH loopback fixture: start gate, and its benchmark

## The change

`src/remote/loopback.fixture.ts` is the test fixture that starts a real, owned `/usr/sbin/sshd` on a loopback port
(isolated keys, config, HOME and registry) for the remote tests in `src/remote/*.test.ts`: `canonical_paths`,
`channel_faults`, `channel_reuse`, `external_state`, `policy_match`, `storage_failure` and `transport` import it. No
non-test module imports it, and nothing outside the tests runs it.

The fixture used to wait a fixed 250 ms after spawning sshd and then check that it had not exited. It now polls, every
5 ms and for at most the same 250 ms, until `sshd.pid` (the fixture's own `PidFile`) holds the spawned child's pid.
OpenSSH writes that file only after its listen sockets are bound. Whatever ends the wait, the same check follows as
before: if the child has exited, the same error is thrown. If the pid file never appears, the fixture behaves exactly as
before, waiting 250 ms and then continuing.

Nothing else in the fixture changed: the ledger, the `OWNED_SSHD` line, the transport hardening and the cleanup (which
checks the owned pid's command with `/bin/ps` before it signals it) are all the same.

**Known difference:** the base wait would have noticed an sshd that crashed within 250 ms *after* writing its pid file;
the gate returns before that. Such a crash would then show up at the first SSH connection instead of in the fixture.
The probe below checks for this on every start (`alive_at_250ms`), and no such crash was seen.

## The benchmark: `scripts/perf_loopback_start_probe.mjs`

The probe starts the real owned sshd through the fixture, alternating the base and the current version in ABBA order.
For each start it records:

- the fixture's start time;
- whether this sshd wrote its own pid file, and when;
- a real SSH `probe()` through the fixture's transport, which must report `exec: true`;
- whether the owned sshd is still alive 250 ms after its spawn;
- the fixture's own `close()`, including its `/bin/ps` identity check.

It runs under `tests/preload.ts` isolation and signals no other process. On an interruption it waits for the start in
progress to settle, closes that fixture, and records any cleanup failure. It asserts no timing threshold. Exit 0 means
every start, connect, alive check and close succeeded, so the counts also serve as a structural regression check.

Run it in `backend-ts/` with dependencies installed, while no test run uses the tree:

```sh
bun scripts/perf_loopback_start_probe.mjs --base a4dc9ca3bfddfa9cc57b50ba5f68c914a5772d10 --out <new empty dir> --starts 6
```

Probe sha256: `b2dc453fdf16d0bf87f306ca38ce5387fbe72051d054246382bc57c82f2e4a2b`.

## Measured (2026-10-18 17:31:08–17:31:19 UTC)

- **Machine:** macOS 27.0.1 arm64, `/usr/sbin/sshd` OpenSSH_10.3p1 (LibreSSL 3.3.6), Bun 1.4.0, 6 starts per variant.
- **Load:** the host had unknown background load (load average about 7–8), so it is not claimed idle.
- **Exit:** the probe exited 0 after 10.83 s of wall time.
- **Raw data:** `scripts/perf_loopback_start_results/20261018T173108Z/` holds `starts.jsonl` (all 12 samples),
  `meta.json` and `summary.json`, byte-for-byte as written. They contain no host home path, so nothing was replaced.

| | base (fixed 250 ms) | after (pid-file gate) |
|---|---|---|
| fixture start, median of 6 | 273.554 ms (273.256–276.400) | 28.888 ms (27.301–29.364) |
| own pid file written, median after spawn | 4.85 ms (6/6) | 4.77 ms (6/6) |
| real SSH probe `exec: true` | 6/6 | 6/6 |
| sshd alive at spawn + 250 ms | 6/6 | 6/6 |
| fixture `close()` (identity check, own sshd ended) | 6/6 | 6/6 |
| SSH probe after start, median | 711.871 ms | 707.448 ms |

- **Start:** each fixture start got 244.666 ms shorter (−89.44 %, median against median).
- **Cleanup:** `close_failed` is `[]` and `copy_left` is `false`.
- **Connect:** the connect times are the same within noise. This change claims no connection gain.

## What this is not

- **Not the backend suite's wall time.** The numbers above are the fixture's start cost only. The fixture starts once
  per remote test that uses it. Multiplying the per-start saving by the number of starts gives a figure that was not
  measured and must not be quoted as a suite gain.
- **Not an end-to-end gate yet.** The final gates on the commit that holds this change have not been run; they are
  pending. Their expected counts are:
  - backend `bun run test` (`--timeout 60000`): 1511 tests, 1509 pass, 0 fail, the 2 existing platform skips, 211 files;
  - frontend `npm test`: 749 tests, 749 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo;
  - all 20 e2e on port 8399;
  - the CI steps on Node 24.

  No package command, timeout, skip or filter was changed.

## Also measured, and withdrawn

Two frontend test-clock changes were measured in the same session and withdrawn:

- `collabStore` (mocked refresher clock);
- `agentPresentation` (virtual 450 ms windows).

Single-file medians fell from 5.33 s to 0.34 s and from 3.23 s to 1.43 s. But in the whole `npm test` run in A/B/A order,
the after state was only 0.096 s faster than the second, warm base run (38.177 s against 38.273 s; the first base run,
41.099 s, had a cold typecheck cache). That is not a suite gain worth changing a test's clock for. Both test files are
back at their base blobs, and the detailed negative result is kept outside the repository with the audit material.
