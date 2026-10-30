/** Independent product-policy regressions over real system sshd, not a mock transport.
 * Script decisions are scoped by conversation returns/markers, never a global steps cursor. */
import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoopbackSshd } from './remote/loopback_sshd.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { setModel, waitDone, scriptedModel } from './harness.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart, userTexts } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'

async function fixture() {
  const f = await LoopbackSshd.start()
  writeFileSync(join(f.workspace, 'proof.txt'), 'INITIAL\n')
  const app = await makeApp(null, { remote_transport: { config_file: f.configFile, known_hosts_file: f.knownHostsFile, rpc_timeout_ms: 7000 } })
  const c = new Client(app)
  const host = await json(await c.post('/api/ssh/targets', { label: 'QA permissions', destination: f.alias, identity_file: f.clientKey }), 201)
  await json(await c.post(`/api/ssh/targets/${host.id}/connect`))
  const project = await json(await c.post('/api/projects', { source_path: f.workspace, mode: 'direct', target: { kind: 'ssh', target_id: host.id } }))
  return { f, app, c, host, project, close: async () => { await app.close(); await f.close() } }
}
for (const mode of ['plan', 'approve'] as const) test(`remote Full + ${mode}: file mutation is blocked/gated, not silently applied`, async () => {
  const { f, app, c, host, project, close } = await fixture()
  let returned: Record<string, unknown> | null = null
  try {
    const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: mode, model: 'scripted:a', access_mode: 'full', mode }))
    setModel(app.state, 'scripted:a', scriptedModel((messages) => {
      if (lastToolReturn(messages, 'read_file') === null) return modelResponse([toolCallPart('read_file', { path: 'proof.txt' }, '')])
      if (lastToolReturn(messages, 'edit_file') === null) return modelResponse([toolCallPart('edit_file', { path: 'proof.txt', old_string: 'INITIAL', new_string: 'CHANGED' }, '')])
      returned = lastToolReturn(messages, 'edit_file') as Record<string, unknown>
      return modelResponse([textPart('QA_TOOL_RETURNED_NOT_A_SUCCESS_CLAIM')])
    }))
    const chat = await json(await c.post(`/api/sessions/${session.id}/chat`, { text: 'QA_PERMISSION_EDIT' }))
    await waitDone(app.state, String(chat.id))
    expect(readFileSync(join(f.workspace, 'proof.txt'), 'utf8')).toBe('INITIAL\n')
    expect(repo.listJournal(app.state.conn, { run_id: String(chat.id) })).toHaveLength(0)
    expect(returned).not.toBeNull()
    if (mode === 'plan') expect(returned).toMatchObject({ status: 'blocked', reason: 'plan_mode' })
    else {
      const result = returned as unknown as { status: string; proposal_asset_id: string }
      expect(result.status).toBe('action_gated')
      const proposal = await json(await c.get(`/api/action-proposals/${result.proposal_asset_id}`))
      expect(JSON.stringify(proposal.payload)).toContain(String(host.id))
      // An explicit disconnect must not be bypassed by approving a previously prepared write.
      await json(await c.post(`/api/ssh/targets/${host.id}/disconnect`))
      const decided = await c.post(`/api/action-proposals/${result.proposal_asset_id}/decide`, { decision: 'approve' })
      const body = await decided.json() as Record<string, unknown>
      expect(decided.status >= 400 || JSON.stringify(body).includes('remote_unavailable'), JSON.stringify(body)).toBe(true)
      expect(readFileSync(join(f.workspace, 'proof.txt'), 'utf8')).toBe('INITIAL\n')
    }
  } finally { await close() }
}, 45_000)

test('two SSH targets that name the same canonical root share the product writer lock', async () => {
  const { f, app, c, host, project, close } = await fixture()
  let release!: () => void, entered!: () => void, secondEntered = false
  const held = new Promise<void>((r) => { release = r }), started = new Promise<void>((r) => { entered = r })
  try {
    const alias = await json(await c.post('/api/ssh/targets', { label: 'Alias of same SSH host', destination: f.alias, identity_file: f.clientKey }), 201)
    await json(await c.post(`/api/ssh/targets/${alias.id}/connect`))
    const otherProject = await json(await c.post('/api/projects', { source_path: f.workspace, mode: 'direct', target: { kind: 'ssh', target_id: alias.id } }))
    const first = await json(await c.post(`/api/projects/${project.id}/sessions`, { title: 'first', model: 'scripted:a' }))
    const second = await json(await c.post(`/api/projects/${otherProject.id}/sessions`, { title: 'second', model: 'scripted:a' }))
    setModel(app.state, 'scripted:a', scriptedModel(async (messages) => {
      if (userTexts(messages).some((s) => s.includes('QA_ALIAS_FIRST'))) { entered(); await held }
      else secondEntered = true
      return modelResponse([textPart('QA_ALIAS_END')])
    }))
    const one = await json(await c.post(`/api/sessions/${first.id}/chat`, { text: 'QA_ALIAS_FIRST' }))
    await started
    const secondResponse = await c.post(`/api/sessions/${second.id}/chat`, { text: 'QA_ALIAS_SECOND' })
    const two = await secondResponse.json() as Record<string, unknown>
    // The POST may answer 'running' before asynchronous queue acquisition; inspect persisted state,
    // and give a wrongly-unlocked second model enough time to actually enter.
    await Bun.sleep(1500)
    const observed = secondResponse.status < 300 ? await json(await c.get(`/api/runs/${two.id}`)) : two
    expect(secondEntered, `second model entered while first holds same physical root; ${JSON.stringify(observed)}`).toBe(false)
    expect(secondResponse.status === 409 || observed.status === 'queued', JSON.stringify(observed)).toBe(true)
    release()
    await waitDone(app.state, String(one.id))
    if (secondResponse.status < 300) await waitDone(app.state, String(two.id))
    expect(host.id).not.toBe(alias.id)
  } finally { release(); await close() }
}, 45_000)
