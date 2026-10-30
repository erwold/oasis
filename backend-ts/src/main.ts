/** App factory and entry point. Data, config, port and logs are the harness's own (OASIS_CODE_*); the server binds
 *  127.0.0.1 unless told otherwise; the isolation runtime is probed at startup and its report is what the product
 *  shows. */

import { backfillCallDetails } from './director/call_details.ts'
import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { Hono } from 'hono'
import { z } from '@oasis-code/contract'
import { UsageService } from './auth/usage.ts'
import { LoginManager } from './auth/web_login.ts'
import { credentialStore, tokenManager } from './auth/store.ts'
import { setFittedImageDir } from './llm/image_fit.ts'
import { searchRoutes } from './api/search.ts'
import { accountRoutes } from './api/accounts.ts'
import { directorRoutes } from './api/director.ts'
import { AGENT_RUN_HEADER, CONNECTOR_HEADER, loadOrMintToken, printedToken, sessionAuth } from './api/auth.ts'
import { DIRECTOR_SESSION_HEADER, DIRECTOR_TURN_HEADER, HttpError, TOOL_SURFACE_HEADER, type Api } from './api/common.ts'
import { effectiveAccess, requestCap, withRequestCap } from './policy/access.ts'
import { agentCaller, agentRouteAllowed } from './policy/delegation.ts'
import { fsRoutes } from './api/fs.ts'
import { sshRoutes } from './api/ssh.ts'
import { RemoteRefused } from './workspace/remote.ts'
import { RemoteError } from './remote/types.ts'
import { lockKeyOf } from './workspace/locks.ts'
import { cohortKeyOf } from './workspace/cohort.ts'
import { gateRoutes } from './api/gate.ts'
import { rootRoutes } from './api/roots.ts'
import { attachmentRoutes } from './api/attachments.ts'
import { closeUploads, uploadRoutes } from './api/uploads.ts'
import { metaRoutes } from './api/meta.ts'
import { projectRoutes } from './api/projects.ts'
import { relayRoutes } from './api/relays.ts'
import { interactionRoutes } from './api/interactions.ts'
import { runRoutes } from './api/runs.ts'
import { collaborationRoutes } from './api/collaboration.ts'
import { sessionRoutes } from './api/sessions.ts'
import { shareRoutes } from './api/share.ts'
import { liveShareRoutes } from './api/live_share.ts'
import { LiveShareService, type LiveShareServiceOptions } from './share/live/service.ts'
import { sessionActivityRoutes } from './api/session_activity.ts'
import { uiRoutes } from './api/ui.ts'
import { UpgradeBackupFailed } from './db/database.ts'
import { DataInUse } from './db/instance.ts'
import * as repo from './db/repo.ts'
import { buildState, closeState, type AppState, type BuildOptions } from './api/state.ts'
import { workspaceRoutes } from './api/workspace.ts'
import { getSettings, type HarnessConfig, type Settings } from './config.ts'
import { redactSecrets } from './llm/redact.ts'
import { FRONTEND_DIST } from './version.ts'
import { FolderUnreachable } from './workspace/paths.ts'

export interface App {
  app: Hono
  state: AppState
  logins: LoginManager
  usage: UsageService
  /** the fetch handler for Bun.serve (the second argument carries the peer address) */
  fetch: (request: Request, server?: unknown) => Response | Promise<Response>
  start(): Promise<Record<string, unknown>>
  close(): Promise<void>
}

export interface CreateOptions extends BuildOptions {
  logins?: LoginManager
  usage?: UsageService
  /** the live share's service (tests: an in-process projector, an ephemeral port); its listener binds on start() only */
  live_share?: LiveShareServiceOptions
}

const DIST = FRONTEND_DIST

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** A file of the built frontend for a page path, or null: index.html for a directory, nothing outside dist. */
function staticFile(pathname: string): string | null {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  if (rel.split(/[/\\]/).includes('..')) return null
  const target = resolve(DIST, rel)
  if (!target.startsWith(DIST)) return null
  if (isFile(target)) return target
  const index = join(target, 'index.html')
  return isFile(index) ? index : null
}

export async function createApp(settingsIn?: Settings | null, configIn?: HarnessConfig | null, opts: CreateOptions = {}): Promise<App> {
  const state = await buildState(settingsIn, configIn, opts)
  const { settings } = state
  state.session_token = loadOrMintToken(settings.session_token, settings.data_dir)
  // the images a request sends fitted (llm/image_fit.ts) are made once and kept here, not made again on every request
  setFittedImageDir(join(settings.data_dir, 'image-variants'))
  // the OAuth grants and the saved keys live beside the database (buildState pointed the store there)
  const logins = opts.logins ?? new LoginManager(credentialStore(), { manager: tokenManager() })
  const usage = opts.usage ?? UsageService.fromEnvironment()
  const api: Api = { state, logins, usage }
  state.live_share = new LiveShareService(state, opts.live_share)

  const app = new Hono()
  app.use('*', sessionAuth(state.session_token))
  // what a request starts holds the cap its headers name (a director tool surface v1–v5, a connector's client): policy/access.ts
  // a run's own tool calling in process (open_ssh_session) names its run: checked against the live runs, held to that
  // run's bounds and recorded as the agent's — a header that does not check out is refused, never read as the person's
  // (policy/delegation.ts)
  app.use('*', async (c, next) => {
    const cap = requestCap({ surface: c.req.header(TOOL_SURFACE_HEADER), connector: c.req.header(CONNECTOR_HEADER) })
    const named = (c.req.header(AGENT_RUN_HEADER) ?? '').trim()
    if (!named) return withRequestCap(cap, async () => { await next() })
    const agent = agentCaller(state.conn, (runId) => { const h = state.runs.handles.get(runId); return h !== undefined && !h.done }, named)
    // one caller per request: an agent run's header beside a director's, a surface's or a connector's is no caller at all
    const others = [TOOL_SURFACE_HEADER, CONNECTOR_HEADER, DIRECTOR_SESSION_HEADER, DIRECTOR_TURN_HEADER].some((h) => (c.req.header(h) ?? '').trim() !== '')
    if (agent === null || others) return c.json({ detail: 'the agent run this request names is not a live run of this app, or the request names another caller beside it', code: 'invalid_agent_context' }, 403)
    if (!agentRouteAllowed(c.req.method, new URL(c.req.url).pathname)) return c.json({ detail: 'an agent run may not make this request; it is the person\'s, in oasis-code', code: 'agent_route' }, 403)
    const caller = repo.getSession(state.conn, agent.session_id)!
    const runCap = effectiveAccess({ session: caller, run_cap: repo.runAccessCap(state.conn, agent.run_id) }) === 'sandbox' ? 'sandbox' : null
    return withRequestCap(cap === 'sandbox' || runCap === 'sandbox' ? 'sandbox' : null, async () => { await next() }, agent)
  })
  app.onError((error, c) => {
    if (error instanceof RemoteError) return c.json({ detail: error.message, code: error.code, status: error.status, retryable: error.retryable, operation_id: error.operation_id }, error.status === 'conflict' ? 409 : error.status === 'disconnected' || error.status === 'unknown' ? 503 : 400)
    if (error instanceof RemoteRefused) return c.json({ detail: error.message, code: error.code }, error.status as 400)
    if (error instanceof HttpError) return c.json({ ...(error.extra ?? {}), ...(error.code !== null ? { detail: error.message, code: error.code } : { detail: error.message }) }, error.status as 400)
    if (error instanceof z.ZodError) return c.json({ detail: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 422)
    // a folder edited in place that cannot be reached where it was opened: a state of the person's disk, said as it is
    if (error instanceof FolderUnreachable) return c.json({ detail: error.message }, 409)
    // the response says that something failed and where to find it; what failed stays in the log under the same
    // reference, with anything that looks like a credential masked (an exception a library wrote may quote a key)
    const reference = `err_${randomBytes(4).toString('hex')}`
    const described = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error)
    console.error(`internal error ${reference} on ${c.req.method} ${new URL(c.req.url).pathname}: ${redactSecrets(described)}`)
    return c.json({ detail: `internal error (reference ${reference}); the server log has the details`, reference }, 500)
  })
  for (const routes of [metaRoutes, projectRoutes, sessionRoutes, sessionActivityRoutes, runRoutes, collaborationRoutes, relayRoutes, interactionRoutes, workspaceRoutes, gateRoutes, rootRoutes, attachmentRoutes, uploadRoutes, fsRoutes, sshRoutes, accountRoutes, searchRoutes, directorRoutes, uiRoutes, shareRoutes, liveShareRoutes]) app.route('/', routes(api))
  // a native director's tools are the director endpoint's own, calling this app in process
  state.director.attachHarness((input, init) => Promise.resolve(app.request(input, init)))

  app.get('/', (c) => {
    const token = c.req.query('token')
    if (token) return c.redirect(`/api/auth/session?token=${encodeURIComponent(token)}`, 303)
    const index = join(DIST, 'index.html')
    if (isFile(index)) return new Response(Bun.file(index), { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' } })
    return c.json({ 'oasis-code': 'build the frontend (frontend/: npm run build) or use the API' })
  })
  app.notFound((c) => {
    const pathname = new URL(c.req.url).pathname
    if (pathname.startsWith('/api/') || c.req.method !== 'GET' || !existsSync(DIST)) return c.json({ detail: 'Not Found' }, 404)
    const file = staticFile(pathname)
    if (file === null) return c.json({ detail: 'Not Found' }, 404)
    return new Response(Bun.file(file), { headers: file.endsWith('index.html') ? { 'Cache-Control': 'no-store' } : {} })
  })

  return {
    app, state, logins, usage,
    fetch: (request, server) => app.fetch(request, server === undefined ? undefined : { server }),
    async start() {
      // a file-tool write in a folder edited in place that was kept but never marked (a stop between the two) — settled
      // first, so the receipt of a run that died with it counts what the journal now says the run wrote
      const journalled = state.workspaces.journal.recover((id) => repo.getWorkspace(state.conn, id))
      if (Object.values(journalled).some((n) => n > 0)) console.warn(`journal settled at startup: ${JSON.stringify(journalled)}`)
      const counts = await state.runs.reconcile()
      if (Object.values(counts).some((v) => (Array.isArray(v) ? v.length : v))) console.warn(`reconciled at startup: ${JSON.stringify(counts)}`)
      const relays = state.relays.reconcile()
      if (relays.interrupted.length || relays.finished.length) console.warn(`relays reconciled at startup: ${JSON.stringify(relays)}`)
      const interactions = state.interactions.reconcile()
      if (interactions.interrupted.length) console.warn(`interactions reconciled at startup: ${JSON.stringify(interactions)}`)
      const detailed = backfillCallDetails(state.conn)
      if (detailed) console.warn(`director turns given their calls' arguments and outcomes from the director's record: ${detailed}`)
      const directed = await state.director.reconcile()
      if (directed.interrupted.length || directed.resumed.length) console.warn(`director sessions reconciled at startup: ${JSON.stringify(directed)}`)
      // Rehydrate remote ownership before watches and restore writer pins without local PID reaping.
      const remoteWorkspaces = new Set(state.conn.all(repo.REMOTE_EXECUTION_WORKSPACES_SQL).map(r => String(r.workspace_id)))
      const recoveryGroups = new Map<string, { workspaceId: string; ids: string[] }>()
      for (const workspaceId of remoteWorkspaces) {
        const ws = repo.getWorkspace(state.conn, workspaceId)
        if (!ws) continue
        const ids = state.processes.runningInWorkspace(workspaceId).filter(id => state.processes.isRemoteExecution(id))
        if (!ids.length) continue
        const key = lockKeyOf(ws, workspaceId), group = recoveryGroups.get(key) ?? { workspaceId, ids: [] }
        group.ids.push(...ids); recoveryGroups.set(key, group)
      }
      for (const [key, { workspaceId, ids }] of recoveryGroups) {
        const owner = `remote-recovery:${key}`
        // the jobs are one conversation's own commands only when every record proves it (RemoteFiles.provenCohort):
        // then a later run of that conversation works beside them, as before the restart; anything mixed, owned, of an
        // approval or of unknown origin keeps the folder exclusive until it ends
        const ws = repo.getWorkspace(state.conn, workspaceId)
        let proven: ReturnType<NonNullable<typeof state.workspaces.remoteFiles>['provenCohort']> = null
        try { proven = ws !== null && ids.every((id) => repo.getExecution(state.conn, id)?.workspace_id === workspaceId) ? state.workspaces.remoteFiles?.provenCohort(ws) ?? null : null } catch { proven = null }
        const runOf = (id: string) => repo.getExecution(state.conn, id)?.run_id ?? null
        const meta = proven !== null
          ? { kind: 'run' as const, run_id: runOf(ids[0]!), session_id: proven.cohort.session_id, cohort: cohortKeyOf(proven.cohort), execution_id: ids[0], operation: 'remote_recovery' }
          : { kind: 'command' as const, execution_id: ids[0], operation: 'remote_recovery' }
        if (state.locks.tryAcquire(workspaceId, owner, meta)) {
          for (const id of ids) state.locks.holdUntil(workspaceId, owner, id, state.processes.wait(id, null), { run_id: runOf(id), joinable: proven !== null })
          state.locks.release(workspaceId, owner)
        }
      }
      const watched = state.watches.start()
      state.remote_driver.startPolling()
      // the targets the person left connected are dialed again (in the background, on the reconnection schedule);
      // a target they disconnected, or never connected, is not
      const resumed = state.remote.resume()
      if (resumed.length) console.warn(`ssh targets reconnecting at startup: ${resumed.length}`)
      if (watched.lost || watched.ended || watched.expired) console.warn(`watches reconciled at startup: ${JSON.stringify(watched)}`)
      // the share-only listener, when the person turned it on (default off); a bind error is its status, not a stop
      await state.live_share?.start()
      return counts
    },
    async close() {
      await logins.close()
      await closeUploads(state)
      await closeState(state)
    },
  }
}

/** A start that cannot go on, as the one line that says why (the port taken, the data directory held by another
 *  harness, the copy before a database upgrade not made); null for anything else, which is a bug and keeps its stack. */
export function startupFailure(error: unknown, settings: Pick<Settings, 'host' | 'port'>): string | null {
  if (error instanceof DataInUse || error instanceof UpgradeBackupFailed) return error.message
  if (error instanceof Error && (error as { code?: unknown }).code === 'EADDRINUSE') {
    return `port ${settings.port} on ${settings.host} is already in use (another oasis-code, or another program); stop it, or set OASIS_CODE_PORT to a free port`
  }
  return null
}

export async function main(): Promise<void> {
  const settings = getSettings()
  // the port is taken first, so a start that cannot listen ends before any run is reconciled, any director session
  // resumed or any watch restarted; requests that arrive meanwhile wait for the start to finish
  const ready = Promise.withResolvers<App>()
  let server: ReturnType<typeof Bun.serve> | null = null
  let built: App | null = null
  try {
    server = Bun.serve({ hostname: settings.host, port: settings.port, fetch: async (request, srv) => (await ready.promise).fetch(request, srv), idleTimeout: 255 })
    built = await createApp(settings)
    await built.start()
  } catch (error) {
    const reason = startupFailure(error, settings)
    if (reason === null) throw error
    server?.stop(true)
    if (built !== null) await built.close()
    console.error(`oasis-code did not start: ${reason}`)
    process.exit(1)
  }
  const app = built
  const listening = server
  ready.resolve(app)
  const report = app.state.isolation
  const printed = printedToken(app.state.session_token, { explicit: !!settings.session_token, env: 'OASIS_CODE_SESSION_TOKEN', dataDir: settings.data_dir, filename: 'session-token' }, process.stderr.isTTY === true)
  console.warn(`oasis-code on http://${settings.host}:${listening.port}/?token=${printed.token}  (${printed.note ? `${printed.note}; ` : ''}isolation: ${report.runtime} ${report.enforcement})`)
  const stop = async () => {
    listening.stop()
    await app.close()
    process.exit(0)
  }
  process.on('SIGINT', () => { void stop() })
  process.on('SIGTERM', () => { void stop() })
}
