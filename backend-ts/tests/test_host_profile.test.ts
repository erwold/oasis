/** The host-restricted profile (execution/isolation.ts hostProfile). A Full access command with restrictions chosen
 *  for it runs as the user on the host under `(allow default)`, with only those restrictions added: the network
 *  denied; writes, hard links, removal and rename refused for read-only paths, with their ancestors pinned; a work
 *  order's bounds. There is no credential deny, no HOME of the harness's and no rlimit.
 *
 *  The first tests check the profile text and the argv (configuration evidence, not OS evidence). The last test is the
 *  OS evidence. It applies the profile with sandbox-exec and runs only where sandbox-exec can apply one. Inside another
 *  sandbox it cannot ("sandbox_apply: Operation not permitted"), so the test is skipped and says so. Nothing is
 *  claimed for it then. */

import { expect, test } from 'bun:test'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { BubblewrapRuntime, CREDENTIAL_READ_DENY, hostProfile, hostRestricted, SeatbeltRuntime, type OrderBounds } from '../src/execution/isolation.ts'
import { tempDir } from './helpers.ts'

/** A command's stdout, whatever its exit, the event loop left running meanwhile. */
const stdoutOf = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve) => { execFile(file, args, { encoding: 'utf8' }, (_error, stdout) => resolve(stdout)) })

test('only the chosen rules: the network off alone is `(deny network*)` over `(allow default)` — no file rule, no credential deny, no limit', () => {
  const profile = hostProfile({ network: false, write_deny: [] })
  expect(profile.split('\n').filter((l) => l && !l.startsWith(';;'))).toEqual(['(version 1)', '(allow default)', '(deny network*)'])
  for (const store of CREDENTIAL_READ_DENY) expect(profile).not.toContain(store.slice(2))
  expect(profile).not.toContain('ulimit')
  expect(hostRestricted({ network: false, write_deny: [] })).toBe(true)
  expect(hostRestricted({ network: true, write_deny: [] })).toBe(false)
  expect(hostRestricted({ network: true, write_deny: [], bounds: null })).toBe(false)
  expect(hostRestricted(null)).toBe(false)
})

test('read-only paths: writes and hard links refused below them; they and every folder above them pinned against removal and rename; the network untouched', () => {
  const base = tempDir('oasis-hp-')
  const ro = join(base, 'a', 'ro')
  mkdirSync(ro, { recursive: true })
  const profile = hostProfile({ network: true, write_deny: [ro, ro] })
  expect(profile).not.toContain('network*')
  expect(profile).toContain(`(deny file-write*\n  (subpath "${ro}"))`)
  expect(profile).toContain(`(deny file-link\n  (subpath "${ro}"))`)
  for (const op of ['file-write-unlink', 'file-write-create']) {
    const rule = profile.slice(profile.indexOf(`(deny ${op}`))
    expect(rule).toContain(`(literal "${ro}")`)
    expect(rule).toContain(`(literal "${join(base, 'a')}")`)
    expect(rule).toContain(`(literal "${base}")`)
    expect(rule).not.toContain('(literal "/")')
  }
  // the denies come after everything they could be reopened by
  expect(profile.lastIndexOf('(deny file-write*')).toBeGreaterThan(profile.indexOf('(allow default)'))
})

test('a work order\'s bounds keep their rules (protected paths left to the file tools); read-only paths are denied after the scope\'s allows', () => {
  const root = tempDir('oasis-hpo-')
  const bounds: OrderBounds = { root, read_only: false, read: null, write: ['src/**'], protected: ['secrets/**'], repository: [] }
  const locked = join(root, 'src', 'locked.txt')
  const profile = hostProfile({ network: true, write_deny: [locked], bounds })
  expect(profile).toContain(`(deny file-write*\n  (subpath "${root}"))`)
  expect(profile).toContain(`(allow file-write*\n  (subpath "${root}/src"))`)
  expect(profile).not.toContain('secrets')
  expect(profile.lastIndexOf(`(subpath "${locked}")`)).toBeGreaterThan(profile.indexOf(`(allow file-write*\n  (subpath "${root}/src"))`))
})

test('Seatbelt runs the user\'s shell under the profile it writes; a runtime with no host profile (bubblewrap) offers none', () => {
  const dir = tempDir('oasis-hpr-')
  const path = join(dir, 'x.sb')
  const argv = new SeatbeltRuntime().hostCommand(['/bin/zsh', '-l', '-i', '-c', 'true'], { network: false, write_deny: [] }, path)
  expect(argv).toEqual(['sandbox-exec', '-f', path, '/bin/zsh', '-l', '-i', '-c', 'true'])
  expect(readFileSync(path, 'utf8')).toBe(hostProfile({ network: false, write_deny: [] }))
  expect((new BubblewrapRuntime() as { hostCommand?: unknown }).hostCommand).toBeUndefined()
})

/** Whether sandbox-exec can apply a profile here. */
function seatbeltUsable(): { ok: boolean; why: string } {
  if (process.platform !== 'darwin') return { ok: false, why: 'not macOS' }
  const dir = tempDir('oasis-sb-')
  const profile = join(dir, 'p.sb')
  writeFileSync(profile, '(version 1)\n(allow default)\n')
  const r = spawnSync('sandbox-exec', ['-f', profile, '/usr/bin/true'], { encoding: 'utf8' })
  return { ok: r.status === 0, why: `sandbox-exec exit ${r.status}: ${String(r.stderr).trim()}` }
}
const SEATBELT = seatbeltUsable()
if (!SEATBELT.ok) console.warn(`[test_host_profile] Seatbelt enforcement NOT verified on this host (${SEATBELT.why}); the OS test is skipped`)

test.skipIf(!SEATBELT.ok)('Seatbelt holds it: writes into a read-only root, appending to its file, a hard link of it and a rename of its parent refused; the network denied; writes elsewhere allowed', async () => {
  const base = tempDir('oasis-sbhost-')
  const parent = join(base, 'parent')
  const ro = join(parent, 'ro')
  const ok = join(base, 'ok')
  mkdirSync(ro, { recursive: true })
  mkdirSync(ok, { recursive: true })
  writeFileSync(join(ro, 'kept.txt'), 'kept')
  const server = createServer((_q, r) => r.end('reached'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  try {
    const profile = join(base, 'host.sb')
    writeFileSync(profile, hostProfile({ network: false, write_deny: [ro] }))
    const script = [
      `echo x > ${ro}/new.txt; echo "ro_write=$?"`,
      `echo y >> ${ro}/kept.txt; echo "ro_append=$?"`,
      `ln ${ro}/kept.txt ${ok}/alias; echo "ro_link=$?"`,
      `mv ${parent} ${base}/moved; echo "parent_rename=$?"`,
      `echo z > ${ok}/f.txt; echo "ok_write=$?"`,
      `/usr/bin/curl -s -m 3 http://127.0.0.1:${port}/ >/dev/null; echo "net=$?"`,
    ].join('; ')
    // run without blocking this process: its own server must be free to answer, or a closed network and a server that
    // cannot answer would look the same
    const out = await stdoutOf('sandbox-exec', ['-f', profile, '/bin/sh', '-c', script])
    expect(out).toMatch(/ro_write=[1-9]/)
    expect(out).toMatch(/ro_append=[1-9]/)
    expect(out).toMatch(/ro_link=[1-9]/)
    expect(out).toMatch(/parent_rename=[1-9]/)
    expect(out).toContain('ok_write=0')
    expect(out).toMatch(/net=[1-9]/)
    expect(readFileSync(join(ro, 'kept.txt'), 'utf8')).toBe('kept')
    expect(existsSync(join(ro, 'new.txt'))).toBe(false)
    expect(existsSync(parent)).toBe(true)
    // the positive control: the same host reaches its own server without the profile
    expect(await stdoutOf('/usr/bin/curl', ['-s', '-m', '3', `http://127.0.0.1:${port}/`])).toBe('reached')
  } finally {
    server.close()
  }
})
