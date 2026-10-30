/** A short, synthetic check of the SSH loopback fixture's start (src/remote/loopback.fixture.ts) on THIS machine's
 *  /usr/sbin/sshd, before the fixture's start gate is kept or dropped. Both versions of the fixture start the real
 *  owned sshd the same way; they differ only in how long they wait after the spawn (base: a fixed 250 ms; after: until
 *  the sshd.pid file holds that child's pid, at most 250 ms). Per start, alternating base/after, it records:
 *    - start_ms: loopbackFixture() resolved (monotonic);
 *    - pidfile: whether this sshd wrote its PidFile with its own pid, and when (file mtime − ledger spawn time) — i.e.
 *      whether the after gate can fire at all with this sshd, and how early;
 *    - connect: a real SSH probe through the fixture's own transport succeeded after the start (exec true), and its ms;
 *    - alive_at_250ms: whether the owned sshd still runs 250 ms after its spawn, the window the base wait watched (the
 *      after gate may return before it; an early crash there would move where a test fails);
 *    - close: the fixture's own cleanup (it checks the owned process identity before it signals it).
 *  It asserts no timing threshold. Exit 0 only if every start, connect, alive check and close succeeded.
 *  Interrupted (SIGINT/SIGTERM/SIGHUP), it lets the start under way settle, closes that fixture through its own close
 *  (bounded wait; a close that fails or does not finish is recorded with the fixture dir and its ledger, exit 3), removes
 *  its own copy and writes interrupted.json. The fixture's close checks the owned PID's command with /bin/ps first; if
 *  that check is refused or differs, the close fails, nothing is signalled, and the failure is recorded — never bypassed.
 *  Syntax was checked with `node --check` only; its real run (and any CI use) is pending.
 *
 *  It runs under the suite's isolation (tests/preload.ts, imported first: provider keys unset, a temp data dir) and
 *  starts only its own sshd children; it signals nothing else. The base fixture is put beside the after one as
 *  src/remote/zz-ab-<random>-loopback.fixture.base.ts (created exclusively, removed in finally and on a signal) so its
 *  relative imports resolve; run it only when no test run uses this tree.
 *
 *  Run (in backend-ts/, dependencies installed):
 *    bun scripts/perf_loopback_start_probe.mjs --base <full sha> --out <new unique dir> [--starts 6]   (starts per variant) */
import '../tests/preload.ts'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt }
const die = (m) => { console.error(m); process.exit(2) }
const BE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = arg('base'), OUT_ARG = arg('out'), STARTS = Number(arg('starts', '6'))
if (!BASE || !/^[0-9a-f]{40}$/.test(BASE)) die('--base <full 40-hex sha> is required')
if (!OUT_ARG) die('--out <new directory> is required')
if (!Number.isInteger(STARTS) || STARTS < 1) die('--starts must be a positive integer')
const OUT = resolve(OUT_ARG)
if (existsSync(OUT)) die(`--out exists: ${OUT}`)
mkdirSync(OUT, { recursive: true })

const git = (...a) => { const r = spawnSync('git', ['-C', BE, ...a], { maxBuffer: 64 << 20 }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout }
const copy = join(BE, 'src', 'remote', `zz-ab-${randomBytes(6).toString('hex')}-loopback.fixture.base.ts`)
const cleanup = () => { rmSync(copy, { force: true }) }
/** The start under way, readable by the signal handler: the promise of loopbackFixture() (its own sshd may already be
 *  spawned while it is pending), the fixture once it resolved, and its single close (the fixture's own, which checks
 *  the owned PID's command identity with /bin/ps before it signals it — never bypassed here, never another PID). */
let current = null
let interrupted = null
const closeOnce = (c) => (c.closing ??= c.fixture.close().then(() => ({ ok: true }), (error) => ({ ok: false, error: String(error?.message ?? error) })))
const INTERRUPT_WAIT_MS = 60_000
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => {
  if (interrupted) return
  interrupted = sig
  const c = current, record = { ok: false, signal: sig, at_utc: new Date().toISOString(), start: c ? c.i : null }
  if (c) {
    let timer
    const bound = new Promise((r) => { timer = setTimeout(() => r('timeout'), INTERRUPT_WAIT_MS) })
    // a start still pending is let settle (its sshd may be spawned already); then that fixture, and only it, is closed
    const started = await Promise.race([(c.starting ?? Promise.resolve()).then(() => 'settled', () => 'settled'), bound])
    if (started === 'settled' && c.fixture) {
      const closed = await Promise.race([closeOnce(c), bound])
      record.cleanup = closed === 'timeout' ? { ok: false, error: `close did not finish in ${INTERRUPT_WAIT_MS} ms` } : closed
    } else record.cleanup = started === 'timeout' ? { ok: false, error: `the start did not settle in ${INTERRUPT_WAIT_MS} ms` } : { ok: true, note: 'the start failed: no fixture to close' }
    clearTimeout(timer)
    record.fixture_dir = c.fixture?.dir ?? null                // its ledger.json and logs are kept there for whoever coordinates
  }
  cleanup()
  record.copy_left = existsSync(copy)
  try { writeFileSync(join(OUT, 'interrupted.json'), JSON.stringify(record, null, 2) + '\n') } catch { /* the exit code says it */ }
  process.exit(record.cleanup && !record.cleanup.ok ? 3 : 130)
})
const sshdVersion = String(spawnSync('/usr/sbin/sshd', ['-V'], { encoding: 'utf8' }).stderr ?? '').trim()
const meta = { real_utc_start: new Date().toISOString(), head_sha: String(git('rev-parse', 'HEAD')).trim(), base_sha: BASE, starts_per_variant: STARTS, bun: process.versions.bun ?? null, sshd: sshdVersion,
  tracked_changes: String(git('status', '--porcelain', '--untracked-files=no')).split('\n').filter(Boolean), note: 'the machine may carry unknown background load; not claimed idle' }
const rows = []
let setupError = null
try {
  writeFileSync(copy, git('show', `${BASE}:backend-ts/src/remote/loopback.fixture.ts`), { flag: 'wx' })
  const variants = { base: (await import(copy)).loopbackFixture, after: (await import('../src/remote/loopback.fixture.ts')).loopbackFixture }
  for (let i = 0; i < STARTS * 2; i += 1) {
    const variant = (i % 4 === 0 || i % 4 === 3) ? 'base' : 'after'          // ABBA ABBA …: each order position as often for both
    if (interrupted) await new Promise(() => {})              // stopping: the handler closes the current fixture and exits
    const row = { i: i + 1, variant, utc_start: new Date().toISOString(), load_start: loadavg() }
    let f = null
    const c = { i: i + 1, fixture: null, closing: null, starting: null }
    current = c
    try {
      const t0 = performance.now()
      c.starting = variants[variant]()
      f = c.fixture = await c.starting
      row.start_ms = performance.now() - t0
      row.fixture_dir = f.dir
      const ledger = JSON.parse(readFileSync(join(f.dir, 'ledger.json'), 'utf8'))
      row.owned_pid = ledger.pid
      const pidPath = join(f.dir, 'sshd.pid'), spawned = Date.parse(ledger.start_utc)
      row.pidfile_own = existsSync(pidPath) && readFileSync(pidPath, 'utf8').trim() === String(ledger.pid)
      row.pidfile_after_spawn_ms = existsSync(pidPath) ? statSync(pidPath).mtimeMs - spawned : null
      const c0 = performance.now()
      const probe = await f.transport().probe()
      row.connect_ms = performance.now() - c0
      row.connect_ok = probe?.exec === true
      const left = spawned + 250 - Date.now()
      if (left > 0) await new Promise((r) => setTimeout(r, left))
      try { process.kill(ledger.pid, 0); row.alive_at_250ms = true } catch { row.alive_at_250ms = false }   // signal 0: existence only
    } catch (error) {
      row.error = String(error?.message ?? error)
    } finally {
      if (interrupted) await new Promise(() => {})            // the handler owns the close from here
      // the fixture's own close; if its /bin/ps identity check is refused or differs it throws: recorded as a failure,
      // the owned sshd is then NOT signalled by anyone here, and its ledger stays in fixture_dir
      if (f) { const closed = await closeOnce(c); row.close_ok = closed.ok; if (!closed.ok) { row.close_error = closed.error; row.owned_sshd_may_still_run = row.owned_pid ?? null } }
      current = null
      row.utc_end = new Date().toISOString(); row.load_end = loadavg()
      row.ok = !row.error && row.connect_ok === true && row.alive_at_250ms === true && row.close_ok === true
      rows.push(row)
      appendFileSync(join(OUT, 'starts.jsonl'), JSON.stringify(row) + '\n')
      console.log(JSON.stringify({ i: row.i, variant, ok: row.ok, start_ms: row.start_ms && Math.round(row.start_ms), pidfile_own: row.pidfile_own, pidfile_after_spawn_ms: row.pidfile_after_spawn_ms, connect_ok: row.connect_ok, alive_at_250ms: row.alive_at_250ms, error: row.error }))
    }
  }
} catch (error) {
  setupError = String(error?.stack ?? error)
} finally {
  cleanup()
  const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null }
  const of = (v) => rows.filter((r) => r.variant === v)
  const per = (v) => ({ starts: of(v).length, ok: of(v).filter((r) => r.ok).length, start_ms: of(v).map((r) => r.start_ms ?? null), start_ms_median: med(of(v).map((r) => r.start_ms)),
    pidfile_own: of(v).filter((r) => r.pidfile_own).length, pidfile_after_spawn_ms_median: med(of(v).map((r) => r.pidfile_after_spawn_ms)), connect_ms_median: med(of(v).map((r) => r.connect_ms)),
    alive_at_250ms: of(v).filter((r) => r.alive_at_250ms).length })
  const ok = !setupError && !existsSync(copy) && rows.length === STARTS * 2 && rows.every((r) => r.ok)
  meta.real_utc_end = new Date().toISOString()
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ ok, setup_error: setupError, copy_left: existsSync(copy), close_failed: rows.filter((r) => r.close_ok === false).map((r) => ({ i: r.i, error: r.close_error, owned_sshd_may_still_run: r.owned_sshd_may_still_run ?? null, fixture_dir: r.fixture_dir ?? null })), base: per('base'), after: per('after') }, null, 2) + '\n')
  console.log(`${ok ? 'ok' : 'FAILED'}: ${join(OUT, 'summary.json')}`)
  process.exitCode = ok ? 0 : 1
}
