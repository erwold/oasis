/** The isolation probe measures and never assumes. Its network check has a positive control — a loopback server of
 *  the host's own, reached by the host before and after the probe — so a connection that failed because the target
 *  was unreachable or timed out is told apart from one the sandbox refused; without a healthy control, or with the
 *  probe's connection taken by the server, nothing is claimed. The process-group kill and the resource limits are
 *  exercised inside the confinement and reported as measured. */

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DENIAL_CODES, judgeProbe, SeatbeltRuntime, type Sandbox } from '../src/execution/isolation.ts'
import { tempDir } from './helpers.ts'

const printed = (report: Record<string, unknown>) => ({ stdout: `${JSON.stringify(report)}\n`, stderr: '' })
const HELD = { home_write: 'blocked', data_read: 'blocked', meta_write: 'blocked', work_write: 'allowed', home_read: 'allowed', rlimit: 'held', tree_kill: 'killed' }
const HEALTHY = { healthy: true, probe_hits: 0 }

/** A work folder as the probe leaves it: the locked file untouched, the allowed write done. */
function workFolder(): string {
  const root = tempDir('oasis-probe-judge-')
  mkdirSync(join(root, 'meta'))
  writeFileSync(join(root, 'meta', 'locked'), 'x')
  writeFileSync(join(root, 'ok.txt'), 'ok')
  return root
}

function judge(report: Record<string, unknown>, control = HEALTHY) {
  const work = workFolder()
  try { return judgeProbe('t', 'fp', work, join(work, 'never-written'), printed(report), control) } finally { rmSync(work, { recursive: true, force: true }) }
}

test('a connection the sandbox refused, against a healthy control the probe never reached, is network isolation', () => {
  const report = judge({ ...HELD, net: 'denied FailedToOpenSocket' })
  expect(report.enforcement).toBe('full')
  expect(report.network_isolation).toBe(true)
  expect(report.filesystem_isolation).toBe(true)
  expect(report.process_tree_kill).toBe(true)
  expect(report.resource_limits).toBe(true)
  expect(report.diagnostics).toEqual(['net=ok, home_write=ok, data_read=ok, meta_write=ok, work_write=ok, home_read=ok, rlimit=ok, tree_kill=ok'])
})

test('unreachable or timed out is not isolation, nor a denial without a healthy control, nor a connection the server took', () => {
  const unreachable = judge({ ...HELD, net: 'unreachable ConnectionRefused' })
  expect(unreachable.enforcement).toBe('partial')
  expect(unreachable.network_isolation).toBe(false)
  expect(unreachable.diagnostics[0]).toStartWith('net=FAIL')
  expect(unreachable.diagnostics[1]).toBe("network: the probe's connection failed as unreachable ConnectionRefused, not as refused by the sandbox")
  const timedOut = judge({ ...HELD, net: 'timeout TimeoutError' })
  expect(timedOut.network_isolation).toBe(false)
  expect(timedOut.diagnostics[1]).toContain('failed as timeout TimeoutError')
  const noControl = judge({ ...HELD, net: 'denied FailedToOpenSocket' }, { healthy: false, probe_hits: 0 })
  expect(noControl.enforcement).toBe('partial')
  expect(noControl.network_isolation).toBe(false)
  expect(noControl.diagnostics[1]).toContain('could not reach its own control server')
  const reached = judge({ ...HELD, net: 'allowed' }, { healthy: true, probe_hits: 1 })
  expect(reached.network_isolation).toBe(false)
  expect(reached.diagnostics[1]).toBe('network: the sandboxed probe reached the control server (1 connection(s))')
  // a probe that said denied while the server counted its connection: the server's count wins
  expect(judge({ ...HELD, net: 'denied X' }, { healthy: true, probe_hits: 1 }).network_isolation).toBe(false)
  expect(judge({ ...HELD }).network_isolation).toBe(false)    // no net line at all
  // a failure that is not a refusal the sandbox is known to give (a reset, a library's TypeError) is not verified either
  for (const net of ['failed ECONNRESET', 'failed TypeError']) {
    const other = judge({ ...HELD, net })
    expect(other.enforcement).toBe('partial')
    expect(other.network_isolation).toBe(false)
    expect(other.diagnostics[1]).toBe(`network: the probe's connection ${net}, which is not a refusal the sandbox is known to give (FailedToOpenSocket, EPERM, EACCES); not verified`)
  }
})

test('the probe script itself reads only the known refusals as denied: a reset or a TypeError is a failure', () => {
  // the classifier as the script carries it, run on synthetic errors
  const classify = (error: { code?: string; name?: string; cause?: { code?: string } }) => {
    const code = String((error && (error.code || (error.cause && error.cause.code) || error.name)) || 'unknown')
    if (/timeout|timedout|abort/i.test(code)) return 'timeout ' + code
    if (/refused|unreach/i.test(code)) return 'unreachable ' + code
    if (DENIAL_CODES.includes(code)) return 'denied ' + code
    return 'failed ' + code
  }
  expect(classify({ code: 'FailedToOpenSocket', name: 'TypeError' })).toBe('denied FailedToOpenSocket')
  expect(classify({ code: 'EPERM' })).toBe('denied EPERM')
  expect(classify({ code: 'ConnectionRefused' })).toBe('unreachable ConnectionRefused')
  expect(classify({ cause: { code: 'ECONNREFUSED' }, name: 'TypeError' })).toBe('unreachable ECONNREFUSED')
  expect(classify({ name: 'TimeoutError' })).toBe('timeout TimeoutError')
  expect(classify({ code: 'ECONNRESET' })).toBe('failed ECONNRESET')
  expect(classify({ name: 'TypeError' })).toBe('failed TypeError')
  expect(classify({})).toBe('failed unknown')
  // the script embeds the same list
  expect(readFileSync(new URL('../src/execution/isolation.ts', import.meta.url), 'utf8')).toContain("if (${JSON.stringify(DENIAL_CODES)}.includes(code)) return 'denied ' + code")
})

test('the process-group kill and the resource limits are what the probe measured, never assumed', () => {
  const alive = judge({ ...HELD, net: 'denied X', tree_kill: 'not killed (4242 still alive)' })
  expect(alive.enforcement).toBe('partial')
  expect(alive.process_tree_kill).toBe(false)
  expect(alive.resource_limits).toBe(true)
  expect(alive.diagnostics).toContain('process tree kill: not killed (4242 still alive)')
  const loose = judge({ ...HELD, net: 'denied X', rlimit: 'not held (2048 bytes, status 0  )' })
  expect(loose.enforcement).toBe('partial')
  expect(loose.resource_limits).toBe(false)
  expect(loose.process_tree_kill).toBe(true)
  expect(loose.diagnostics).toContain('resource limits: not held (2048 bytes, status 0  )')
  // an older probe that measured neither claims neither
  const { rlimit: _r, tree_kill: _t, ...older } = HELD
  const silent = judge({ ...older, net: 'denied X' })
  expect(silent.process_tree_kill).toBe(false)
  expect(silent.resource_limits).toBe(false)
  expect(silent.enforcement).toBe('partial')
  // nothing printed: everything fails, and the stderr is kept
  const none = judgeProbe('t', 'fp', workFolder(), '/nonexistent/never', { stdout: '', stderr: 'sandbox-exec: bad profile' }, HEALTHY)
  expect(none.enforcement).toBe('partial')
  expect(none.diagnostics.at(-1)).toContain('probe printed no report: sandbox-exec: bad profile')
})

test.skipIf(process.platform !== 'darwin')('macOS: the real Seatbelt probe measures full against a live control; a profile that lets the network through reports partial whatever else is closed', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'oasis-probe-real-'))
  // a local server the probe could reach if its network were open, closed again before the probes run: the verdict
  // must not depend on any target but the probe's own control
  const bystander = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('bystander') })
  const bystanderUrl = `http://127.0.0.1:${bystander.port}`
  expect(await (await fetch(bystanderUrl)).text()).toBe('bystander')
  bystander.stop(true)
  try {
    const real = await new SeatbeltRuntime().probe(dataDir)
    expect(real.enforcement).toBe('full')
    expect(real.network_isolation).toBe(true)
    expect(real.process_tree_kill).toBe(true)
    expect(real.resource_limits).toBe(true)
    expect(real.diagnostics).toEqual(['net=ok, home_write=ok, data_read=ok, meta_write=ok, work_write=ok, home_read=ok, rlimit=ok, tree_kill=ok'])
    class OpenNetwork extends SeatbeltRuntime {
      command(argv: string[], box: Sandbox, profilePath: string): string[] { return super.command(argv, { ...box, network: true }, profilePath) }
    }
    const open = await new OpenNetwork().probe(dataDir)
    expect(open.enforcement).toBe('partial')
    expect(open.network_isolation).toBe(false)
    expect(open.filesystem_isolation).toBe(true)
    expect(open.diagnostics[0]).toStartWith('net=FAIL, home_write=ok')
    expect(open.diagnostics[1]).toBe('network: the sandboxed probe reached the control server (1 connection(s))')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 60_000)
