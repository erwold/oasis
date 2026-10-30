import { expect, test } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Client, json, makeApp } from './api_harness.ts'
import { LoopbackSshd } from './remote/loopback_sshd.ts'

test('real SSH host API: connect/probe/dirs do not initialize state; explicit disconnect blocks implicit reconnect', async () => {
  const fixture = await LoopbackSshd.start()
  mkdirSync(join(fixture.workspace, 'remote-directory'))
  const app = await makeApp(null, { remote_transport: { config_file: fixture.configFile, known_hosts_file: fixture.knownHostsFile, rpc_timeout_ms: 5000 } })
  const client = new Client(app, { ip: '127.0.0.1' })
  try {
    const target = await json<{ id: string; state: string }>(await client.post('/api/ssh/targets', { label: 'Real loopback', destination: fixture.alias, identity_file: fixture.clientKey }), 201)
    expect(target.state).toBe('disconnected')
    const connected = await json<{ state: string; capabilities: Record<string, boolean> }>(await client.post(`/api/ssh/targets/${target.id}/connect`))
    expect(connected.state).toBe('ready')
    expect(connected.capabilities.durable_jobs).toBe(true)
    expect(connected.capabilities.sandbox).toBe(false)
    const dirs = await json<{ path: string; entries: { name: string }[] }>(await client.get(`/api/ssh/targets/${target.id}/dirs`, { path: fixture.workspace }))
    expect(dirs.path).toBe(fixture.workspace)
    expect(dirs.entries.map((e) => e.name)).toContain('remote-directory')
    expect(existsSync(join(fixture.workspace, '.oasis-remote'))).toBe(false)
    expect(existsSync(join(fixture.home, '.oasis-remote'))).toBe(false)
    expect((await json<{ state: string }>(await client.post(`/api/ssh/targets/${target.id}/disconnect`))).state).toBe('disconnected')
    const refused = await client.get(`/api/ssh/targets/${target.id}/dirs`, { path: fixture.workspace })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    const rows = await json<{ id: string; state: string }[]>(await client.get('/api/ssh/targets'))
    expect(rows.find((row) => row.id === target.id)!.state).toBe('disconnected')
    expect((await json<{ state: string }>(await client.post(`/api/ssh/targets/${target.id}/connect`))).state).toBe('ready')
    const foreign = await client.post(`/api/ssh/targets/${target.id}/forwards`, { workspace_id: 'not-owned', remote_port: 8888 })
    expect(foreign.status).toBe(404)
    expect(await json<unknown[]>(await client.get(`/api/ssh/targets/${target.id}/forwards`))).toEqual([])
  } finally { await app.close(); await fixture.close() }
}, 30_000)
