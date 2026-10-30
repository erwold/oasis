import { expect, test } from 'bun:test'
import { Client, json, makeApp } from './api_harness.ts'
import { RemoteRefused } from '../src/workspace/remote.ts'

test('SSH targets preserve identity path as data and reject fixture-only options on public API', async () => {
  const app = await makeApp()
  const c = new Client(app)
  try {
    const target = await json(await c.post('/api/ssh/targets', { label: 'Remote', destination: 'my-alias', identity_file: '/not/read/private key' }), 201)
    expect(target.state).toBe('disconnected')
    expect(target.identity_file).toBe('/not/read/private key')
    const rows = await json<Record<string, unknown>[]>(await c.get('/api/ssh/targets'))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(target.id)
    for (const body of [
      { label: 'x', destination: '-oProxyCommand=bad' },
      { label: 'x', destination: 'ok', config_file: '/user/config' },
      { label: 'x', destination: 'ok', known_hosts_file: '/dev/null' },
    ]) expect((await c.post('/api/ssh/targets', body)).status).toBe(422)
  } finally { await app.close() }
})

test('a remote project cannot silently import a same-named local folder without a remote provider', async () => {
  const app = await makeApp(null, { remote_provider: () => { throw new RemoteRefused('remote_unavailable', 'Fixture provider unavailable.', 503) } })
  const c = new Client(app)
  try {
    const target = await json(await c.post('/api/ssh/targets', { label: 'Remote', destination: 'fixture.invalid' }), 201)
    const res = await c.post('/api/projects', { source_path: app.state.settings.data_dir, mode: 'direct', target: { kind: 'ssh', target_id: target.id } })
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe('remote_unavailable')
    expect(app.state.conn.all('SELECT id FROM projects')).toHaveLength(0)
  } finally { await app.close() }
})
