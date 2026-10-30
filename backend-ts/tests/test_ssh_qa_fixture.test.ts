import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoopbackSshd, inspectPid, portListening } from './remote/loopback_sshd.ts'

// These are fixture acceptance tests, not remote product acceptance. No imports of new product modules.
for (const round of [1, 2]) test(`real system sshd fixture repeat ${round}: fresh keys, HOME, exec/PTY/SFTP/forward and exact PID cleanup`, async () => {
  const f = await LoopbackSshd.start()
  const http = createServer((_req, res) => { res.end('QA_HTTP_ONLY') })
  let tunnel: Awaited<ReturnType<LoopbackSshd['tunnel']>> | undefined
  try {
    expect(readFileSync(f.configFile, 'utf8')).toContain('IdentityAgent none')
    expect(f.sshArgs().slice(0, 2)).toEqual(['-F', f.configFile])
    const env = await f.exec('printf "HOME=%s\\nZDOTDIR=%s\\n" "$HOME" "$ZDOTDIR"; pwd; test -z "$SSH_AUTH_SOCK"; printf STDERR_ONLY >&2; exit 23')
    expect(env.code).toBe(23)
    expect(env.stdout).toBe(`HOME=${f.home}\nZDOTDIR=${f.home}\n${f.home}\n`)
    expect(env.stderr).toBe('STDERR_ONLY')
    const tty = await f.run('/usr/bin/ssh', [...f.sshArgs(['-tt']), 'test -t 0 && printf PTY_OK; exit 17'])
    expect(tty.code).toBe(17); expect(tty.stdout).toContain('PTY_OK')
    const payload = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from('中文\r\n\0')])
    const input = join(f.root, 'upload.bin'), output = join(f.root, 'download.bin'), remote = join(f.workspace, 'remote.bin')
    writeFileSync(input, payload)
    const transfer = await f.run('/usr/bin/sftp', ['-F', f.configFile, '-b', '-', f.alias], `put ${input} ${remote}\nget ${remote} ${output}\n`)
    expect(transfer.code, transfer.stderr).toBe(0)
    expect(readFileSync(output).equals(payload)).toBe(true)
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    tunnel = await f.tunnel((http.address() as { port: number }).port)
    const r = await fetch(`http://127.0.0.1:${tunnel.localPort}/`)
    expect(await r.text()).toBe('QA_HTTP_ONLY')
    await tunnel.close()
    expect(await portListening(tunnel.localPort)).toBe(false)
    // Strict host verification failure is a behavior assertion, not a missing config/import failure.
    writeFileSync(f.knownHostsFile, '')
    const unknownHost = await f.exec('printf MUST_NOT_EXECUTE')
    expect(unknownHost.code).toBe(255)
    expect(unknownHost.stdout).not.toContain('MUST_NOT_EXECUTE')
    expect(unknownHost.stderr).toContain('Host key verification failed')
  } finally {
    if (tunnel) await tunnel.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await f.close()
  }
  expect(existsSync(f.root)).toBe(false)
  expect(await portListening(f.port)).toBe(false)
  for (const record of f.ledger) expect(inspectPid(record.pid)).toBe(null)
}, 30_000)

test('fixture forwarding-denied profile accepts SSH but refuses direct-tcpip', async () => {
  const f = await LoopbackSshd.start({ allowForwarding: false })
  const http = createServer((_req, res) => res.end('MUST_NOT_REACH'))
  let tunnel: Awaited<ReturnType<LoopbackSshd['tunnel']>> | undefined
  try {
    expect((await f.exec('printf EXEC_OK')).stdout).toBe('EXEC_OK')
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
    tunnel = await f.tunnel((http.address() as { port: number }).port)
    await expect(fetch(`http://127.0.0.1:${tunnel.localPort}/`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow()
  } finally {
    if (tunnel) await tunnel.close()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await f.close()
  }
}, 20_000)
