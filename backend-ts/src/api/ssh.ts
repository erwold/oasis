/** SSH host management. Folder paths are interpreted by the remote provider only. */
import { Hono } from 'hono'
import { PortForwardInputSchema, SshTargetInputSchema } from '@oasis-code/contract'
import * as targets from '../db/remote_repo.ts'
import * as repo from '../db/repo.ts'
import { connectorOf, HttpError, parseBody, type Api } from './common.ts'
import { DIRECTOR_SESSION_HEADER } from '../director/harness.ts'
import { CONNECTOR_HEADER } from './auth.ts'
import { z } from '@oasis-code/contract'
import { SshConnectRefused } from '../workspace/ssh_hosts.ts'

/** A connector's question: the host it names, and how long the call waits for the person's answer. */
const SshAskBodySchema = z.object({
  target_id: z.string().min(1).nullable().optional(), destination: z.string().min(1).nullable().optional(), port: z.number().int().min(1).max(65535).nullable().optional(),
  identity_file: z.string().min(1).nullable().optional(), name: z.string().min(1).max(200).nullable().optional(), wait_s: z.number().min(0).max(110).optional(),
}).strict()
const WAIT_S = 50
const refusal = (error: unknown): never => {
  if (error instanceof SshConnectRefused) throw new HttpError(409, error.message, 'ssh_refused')
  throw error
}

export function sshRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api
  app.get('/api/ssh/targets', c => c.json(targets.listTargets(state.conn)))
  app.post('/api/ssh/targets', async c => c.json(targets.createTarget(state.conn, await parseBody(c, SshTargetInputSchema)), 201))
  app.post('/api/ssh/targets/:target_id/connect', async c => {
    const id = c.req.param('target_id'), target = await state.remote.connect(id)
    const recovery = target.state === 'ready' ? await state.workspaces.requireRemoteFiles().recoverTarget(id) : []
    state.remote_driver.startPolling()
    return c.json({ ...state.remote.target(id), recovery })
  })
  app.post('/api/ssh/targets/:target_id/disconnect', async c => c.json(await state.remote.disconnect(c.req.param('target_id'))))
  // a connector asks to save and connect a host: the person answers in the app; the call waits up to wait_s for it
  app.get('/api/ssh/asks', c => c.json(state.ssh.pending()))
  app.post('/api/ssh/asks', async c => {
    const body = await parseBody(c, SshAskBodySchema)
    const plan = await state.ssh.plan(body).catch(refusal)
    if (plan.ready) return c.json({ status: 'connected', target: state.remote.target(plan.target_id!) })
    const ask = state.ssh.ask(plan, connectorOf(c) ?? 'A connector')
    return c.json(await state.ssh.wait(ask.id, (body.wait_s ?? WAIT_S) * 1000))
  })
  app.get('/api/ssh/asks/:ask_id', async c => {
    const wait = Math.min(110, Math.max(0, Number(c.req.query('wait_s') ?? 0) || 0))
    return c.json(await state.ssh.wait(c.req.param('ask_id'), wait * 1000).catch(refusal))
  })
  app.post('/api/ssh/asks/:ask_id/answer', async c => {
    // the person's answer: a connector's or a director's request never answers a question (its own or another's)
    if (c.req.header(CONNECTOR_HEADER) !== undefined || c.req.header(DIRECTOR_SESSION_HEADER) !== undefined) throw new HttpError(403, 'Only the person answers an SSH question, in the app.', 'person_only')
    const body = await parseBody(c, z.object({ connect: z.boolean() }).strict())
    return c.json(await state.ssh.answer(c.req.param('ask_id'), body.connect).catch(refusal))
  })
  app.get('/api/ssh/targets/:target_id/dirs', async c => c.json(await state.remote.listDirs(c.req.param('target_id'), c.req.query('path') ?? '')))
  app.get('/api/ssh/targets/:target_id/forwards', c => c.json(state.remote.listForwards(c.req.param('target_id'))))
  app.post('/api/ssh/targets/:target_id/forwards', async c => {
    const body = await parseBody(c, PortForwardInputSchema)
    const id = c.req.param('target_id')
    const ws = repo.getWorkspace(state.conn, body.workspace_id)
    if (!ws || ws.target?.kind !== 'ssh' || ws.target.target_id !== id) throw new HttpError(404, 'remote workspace not found', 'workspace_not_found')
    if (!ws.remote) throw new HttpError(409, 'Remote root identity is unavailable.', 'root_changed')
    await state.remote.request(ws.remote, 'roots.validate', {})
    return c.json(await state.remote.openForward(id, ws.id, body.remote_port), 201)
  })
  app.delete('/api/ssh/targets/:target_id/forwards/:forward_id', async c => c.json({ closed: await state.remote.closeForward(c.req.param('target_id'), c.req.param('forward_id')) }))
  return app
}
