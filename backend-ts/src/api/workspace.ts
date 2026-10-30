import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { Hono, type Context } from 'hono'
import { CheckConfigSchema, CheckpointBodySchema, CommandBodySchema, IntegrateBodySchema, VerifyBodySchema, type CheckConfig, type Workspace } from '@oasis-code/contract'
import { allowsAgentEffect, inferMode } from '@oasis-code/contract/modes'
import { accessDecision, currentRequestCap, reason, surfaceCap } from '../policy/access.ts'
import { sessionInputFiles } from '../agent/attachment_grants.ts'
import { commandNetwork, commandRefusedNow, executeCommand, type ExecuteOptions } from '../agent/tools/commands.ts'
import { recordHumanRun } from '../agent/human_runs.ts'
import { checkCounts } from '../agent/work_orders.ts'
import { configuredCheckIds } from '../agent/runner.ts'
import * as repo from '../db/repo.ts'
import { newId } from '../ids.ts'
import { effectiveControl, effectiveLocks, shouldGate } from '../policy/gate.ts'
import { reviewFlags, runChecks } from '../verify/checks.ts'
import { findEntities } from '../workspace/entities.ts'
import { GitError } from '../workspace/git.ts'
import { integrate } from '../workspace/integrate.ts'
import { PathPolicy, posixOf, type PolicyRoot } from '../workspace/paths.ts'
import { RemotePathPolicy } from '../workspace/remote_policy.ts'
import { cutPatch, workspaceAttached, isDirect } from '../workspace/service.ts'
import { listWorkspaceFiles, readWorkspaceFile, sha256Of } from '../workspace/reading.ts'
import { MAX_IMAGE_BYTES, measureImage, sniffImage } from '../llm/images.ts'
import { CONNECTOR_IMAGE_SIDE, fitImage } from '../llm/image_fit.ts'
import { credentialStores, effectiveRoots, policyRoots, policyRootsOf, readerRoots, withExcludedRepositories } from '../workspace/roots.ts'
import { connectorOf, DIRECTOR_SESSION_HEADER, HttpError, intQuery, parseBody, TOOL_SURFACE_HEADER, type Api } from './common.ts'
import { authorizedSessionsOf, getDirectorSession } from '../director/store.ts'
import type { AppState } from './state.ts'
import { holderEnds, WorkspaceBusy } from '../workspace/locks.ts'
import { busyHttp, underFolderLock } from './folder_lock.ts'

/** The options of a command of this route, with what the execution layer takes beyond the base interface: the
 *  read-only restriction (enforced by the OS where the command runs; refused when it cannot be) and the session's
 *  roots. */
type RouteCommandOptions = ExecuteOptions

/** The workspace's files whose path ends with `name` (`name` whole, or after a `/`): an answer often names a result by
 *  its file name under a folder it named a line above. A bounded walk — no .git, no node_modules, at most
 *  MEDIA_WALK_ENTRIES entries — that stops once two are found (two are not one picture). */
const MEDIA_WALK_ENTRIES = 20_000
function filesEndingWith(root: string, name: string): string[] {
  const found: string[] = []
  let seen = 0
  const walk = (dir: string, rel: string) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (found.length > 1 || ++seen > MEDIA_WALK_ENTRIES) return
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'node_modules') walk(join(dir, e.name), path) }
      else if (e.isFile() && (path === name || path.endsWith(`/${name}`))) found.push(path)
    }
  }
  walk(root, '')
  return found
}

function requireWorkspace(state: AppState, workspaceId: string, remoteReady = false): Workspace {
  const ws = repo.getWorkspace(state.conn, workspaceId)
  if (ws === null) throw new HttpError(404, `workspace not found: ${workspaceId}`)
  if (ws.target?.kind === 'ssh' && !remoteReady) throw new HttpError(409, 'This operation is not available for a remote direct workspace.', 'capability_unavailable')
  return ws
}

/** The path policy a run of this workspace reads under (the same root, the same protected globs). */
/** The pictures and clips the thread shows from a workspace, by extension. */
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
}

function readPolicy(state: AppState, ws: Workspace, only: readonly string[] | null = null): PathPolicy {
  const project = repo.getProject(state.conn, ws.project_id)
  const protectedPaths = [...state.config.protected_paths, ...(((project?.config.protected_paths as string[] | undefined) ?? []))]
  if (ws.target?.kind === 'ssh') return new RemotePathPolicy(ws, protectedPaths)
  // the roots of the sessions working in it (or of those named), read-only (these routes never write)
  const roots = readerRoots(state.conn, ws, only)
  return PathPolicy.forWorkspace(ws.path, protectedPaths, project ? workspaceAttached(project, ws) : null, { pinned: isDirect(ws), roots, root_read_deny: roots.length ? credentialStores() : [] })
}

/** The sessions a request reads a workspace for: a native director's (its director session's header: its bound
 *  session and the sessions it created) that work in it — a folder edited in place is shared by its sessions, their
 *  own roots are not, so a director bound to one never reads another's (an unknown path's refusal, no more); null for
 *  any other caller (the person's client, a connector: every session working in it, as before). */
function viewerSessions(c: Context, state: AppState, ws: Workspace): string[] | null {
  const dsId = (c.req.header(DIRECTOR_SESSION_HEADER) ?? '').trim()
  if (!dsId) return null
  const ds = getDirectorSession(state.conn, dsId)
  const reach = new Set(ds ? [ds.session_id, ...authorizedSessionsOf(ds)] : [])
  return repo.sessionsOfWorkspace(state.conn, ws.id).map((s) => s.id).filter((id) => reach.has(id))
}

/** The roots a workspace's detail says a run there holds: its viewer's sessions' (above), else its own session's. */
function viewerRoots(state: AppState, ws: Workspace, viewers: readonly string[] | null): ReturnType<typeof effectiveRoots> {
  const ids = viewers ?? (ws.session_id ? [ws.session_id] : [])
  const out = new Map<string, PolicyRoot>()
  for (const id of ids) for (const r of policyRootsOf(state.conn, id, ws)) if (!out.has(r.path)) out.set(r.path, r)
  return effectiveRoots([...out.values()])
}

function checksWithStaleness(state: AppState, workspaceId: string): Record<string, unknown>[] {
  const latest = repo.latestSnapshot(state.conn, workspaceId)
  return repo.listChecks(state.conn, workspaceId).map((c) => {
    const snap = repo.getSnapshot(state.conn, c.snapshot_id)
    const stale = latest !== null && snap !== null && snap.tree_sha !== latest.tree_sha
    return { ...c, stale, tree_sha: snap ? snap.tree_sha : null }
  })
}

export function workspaceRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api

  app.get('/api/workspaces/:workspace_id', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'), true)
    return c.json({
      ...ws, status: await state.workspaces.status(ws), lock_owner: state.locks.holder(ws.id), lock: state.locks.state(ws.id), latest_snapshot: repo.latestSnapshot(state.conn, ws.id),
      checkpoints: repo.listCheckpoints(state.conn, ws.id).map((cp) => withExcludedRepositories(state.conn, cp)), executions: repo.listExecutions(state.conn, { workspace_id: ws.id }),
      // schema v29: the roots a run here holds (its own session's; read-only in an isolated copy), each with the access the session registered
      effective_roots: viewerRoots(state, ws, viewerSessions(c, state, ws)),
      checks: checksWithStaleness(state, ws.id),
    })
  })

  /** The @ picker: the workspace's files and the definitions in them matching `q` (`path::symbol` narrows the symbols). */
  app.get('/api/workspaces/:workspace_id/entities', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'))
    const limit = Math.max(1, Math.min(intQuery(c, 'limit', 30), 100))
    return c.json(findEntities(await state.workspaces.listFiles(ws), ws.path, c.req.query('q') ?? '', { limit }))
  })

  /** The files under a directory of the workspace, exactly as a run's read_file of a directory sees them. */
  app.get('/api/workspaces/:workspace_id/files', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'), true)
    if (ws.target?.kind === 'ssh') return c.json(await state.workspaces.requireRemoteFiles().list(ws, c.req.query('path') ?? '.', intQuery(c, 'offset', 0), intQuery(c, 'max_entries', 300)))
    const payload = listWorkspaceFiles(readPolicy(state, ws, viewerSessions(c, state, ws)), await state.workspaces.listFiles(ws), ws.path, c.req.query('path') ?? '.', intQuery(c, 'max_entries', 300), intQuery(c, 'offset', 0))
    if (payload.status !== 'ok') throw new HttpError(400, payload.reason)
    return c.json(payload)
  })

  /** One text file of the workspace with line numbers, paged, with its sha256 — what a run's read_file answers. */
  app.get('/api/workspaces/:workspace_id/file', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'), true)
    if (ws.target?.kind === 'ssh') {
      const path = c.req.query('path')
      if (!path) throw new HttpError(422, 'path is required')
      return c.json(await state.workspaces.requireRemoteFiles().read(ws, path, intQuery(c, 'offset_line', 1), intQuery(c, 'limit_lines', 400)))
    }
    const path = c.req.query('path')
    if (path === undefined) throw new HttpError(422, 'path is required')
    const payload = readWorkspaceFile(readPolicy(state, ws, viewerSessions(c, state, ws)), path, intQuery(c, 'offset_line', 1), intQuery(c, 'limit_lines', 400))
    if (payload.status !== 'ok') throw new HttpError(400, payload.reason)
    return c.json(payload)
  })

  /** One PNG, JPEG or WebP file of the workspace (by its first bytes) as an image a connector shows its model: up to
   *  the upload's limit, read through the same path policy as the file tools (a remote folder's through its target),
   *  fitted to CONNECTOR_IMAGE_SIDE on its long side; `sent` is what the bytes are after fitting. Any other file is a
   *  400 that says so. */
  app.get('/api/workspaces/:workspace_id/image', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'), true)
    const path = c.req.query('path')
    if (!path) throw new HttpError(422, 'path is required')
    let rel: string
    let bytes: Uint8Array
    if (ws.target?.kind === 'ssh') {
      const files = state.workspaces.requireRemoteFiles()
      rel = (await files.resolve(ws, path)).path
      bytes = new Uint8Array(await files.raw(ws, rel, MAX_IMAGE_BYTES))
    } else {
      let pure: string[], real: string
      try { [pure, real] = readPolicy(state, ws, viewerSessions(c, state, ws)).resolveRead(path) } catch (error) { throw new HttpError(400, (error as Error).message) }
      rel = posixOf(pure)
      let st
      try { st = statSync(real) } catch { throw new HttpError(404, `no file at ${path}`) }
      if (!st.isFile()) throw new HttpError(400, `'${rel}' is not a file`)
      if (st.size > MAX_IMAGE_BYTES) throw new HttpError(400, `'${rel}' is ${(st.size / 1024 / 1024).toFixed(1)} MB; images are read up to ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
      bytes = new Uint8Array(readFileSync(real))
    }
    if (sniffImage(bytes) === null) throw new HttpError(400, `'${rel}' is not a PNG, JPEG or WebP image`)
    let original
    try { original = measureImage(bytes) } catch (error) { throw new HttpError(400, `'${rel}': ${(error as Error).message}`) }
    const fitted = fitImage(bytes, original.media_type, sha256Of(bytes), CONNECTOR_IMAGE_SIDE)
    const sent = fitted ?? { bytes, ...original }
    return c.json({
      status: 'ok', path: rel, kind: 'image', media_type: original.media_type, width: original.width, height: original.height, bytes: bytes.length,
      sent: { media_type: sent.media_type, width: sent.width, height: sent.height, bytes: sent.bytes.length }, data_base64: Buffer.from(sent.bytes).toString('base64'),
    })
  })

  /** A picture or a clip of the workspace as its bytes, for the thread to show (an image beside a changed file, a
   *  video that plays): only the media kinds below, read through the same path policy as the file tools, with byte
   *  ranges so a player can seek. Nothing else is served raw — a page or a script would run under this origin. */
  app.get('/api/workspaces/:workspace_id/media', (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'))
    const path = c.req.query('path')
    if (path === undefined) throw new HttpError(422, 'path is required')
    const type = MEDIA_TYPES[extname(path).toLowerCase()]
    if (type === undefined) throw new HttpError(415, `not a picture or a clip the thread shows: ${path}`)
    const policy = readPolicy(state, ws, viewerSessions(c, state, ws))
    const sizeOf = (real: string): number | null => { try { const st = statSync(real); return st.isFile() ? st.size : null } catch { return null } }
    let real: string
    try {
      real = policy.resolveRead(path)[1]
    } catch (error) {
      throw new HttpError(400, (error as Error).message)
    }
    let size = sizeOf(real)
    if (size === null) {
      // not at that path: the one file of the workspace whose path ends with it, read under the same policy
      const named = path.replace(/^\.\//, '')
      const found = named.startsWith('/') || named.split('/').includes('..') || ws.target?.kind === 'ssh' ? [] : filesEndingWith(ws.path, named)
      if (found.length !== 1) throw new HttpError(404, found.length ? `more than one file ends with ${path}` : `no file at ${path}`)
      try { real = policy.resolveRead(found[0]!)[1] } catch (error) { throw new HttpError(400, (error as Error).message) }
      size = sizeOf(real)
      if (size === null) throw new HttpError(404, `no file at ${path}`)
    }
    const headers: Record<string, string> = {
      'content-type': type, 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache',
      'content-security-policy': "default-src 'none'",
    }
    const file = Bun.file(real)
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header('range') ?? '')
    if (range && size > 0) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } })
      return new Response(file.slice(start, end + 1), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) } })
    }
    return new Response(file, { headers: { ...headers, 'content-length': String(size) } })
  })

  app.get('/api/workspaces/:workspace_id/diff', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'), true)
    let result
    const path = c.req.query('path')
    try {
      result = await state.workspaces.diff(ws, { paths: path ? [path] : null, full: c.req.query('full') === '1' })
    } catch (error) {
      if (error instanceof GitError) throw new HttpError(500, error.message)
      throw error
    }
    // the flags read the whole patch; a whole diff too large to send goes in part (a file's own diff whole)
    const shown = path ? { patch: result.patch, cut: null } : cutPatch(result.patch)
    return c.json({ ...result, patch: shown.patch, patch_cut: shown.cut, review_flags: reviewFlags(result.patch, result.files) })
  })

  app.post('/api/workspaces/:workspace_id/checkpoint', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'))
    const body = await parseBody(c, CheckpointBodySchema)
    const session = ws.session_id ? repo.getSession(state.conn, ws.session_id) : null
    const locks = session ? effectiveLocks(state.conn, session.id, repo.getProject(state.conn, ws.project_id)) : []
    const pin = () => state.workspaces.checkpoint(ws, null, body.note, { locks })
    let cp
    try {
      // pinned as the folder's writer (a folder edited in place has no checkpoints: refused as it always was)
      cp = isDirect(ws) ? await pin() : await underFolderLock(state, ws.id, 'checkpoint', pin, (h) => `make the checkpoint ${holderEnds(h)}`)
    } catch (error) {
      if (error instanceof GitError) throw new HttpError(409, error.message)
      throw error
    }
    const snap = repo.getSnapshot(state.conn, cp.snapshot_id)
    // the person's own write is a node on the run tree too
    recordHumanRun(state.conn, {
      session_id: ws.session_id, project_id: ws.project_id, workspace_id: ws.id, label: `checkpoint (${connectorOf(c) ?? 'by hand'})`, text: `checkpoint ${cp.id}: ${body.note}`,
      produced: {
        workspace_id: ws.id, base_commit: ws.base_commit, checkpoints: [cp.id], final_checkpoint_id: cp.id, tree_sha: snap ? snap.tree_sha : null,
        files_changed: (snap ? snap.changed_paths : []).map((ch) => ch.split(' ').slice(1).join(' ') || ch).slice(0, 200),
      },
      kind: 'checkpoint',
    })
    return c.json(cp)
  })

  app.post('/api/workspaces/:workspace_id/verify', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'))
    const body = await parseBody(c, VerifyBodySchema)
    // checks run on a checkpoint's exact commit, in a checkout of their own: a folder edited in place has neither
    if (ws.source_mount) throw new HttpError(409, 'verification checkouts are unavailable for source-mounted outputs; use commands in the isolated workspace')
    if (isDirect(ws)) throw new HttpError(409, 'a folder edited in place has no checkpoints to check out: run the checks as commands in the folder')
    const project = repo.getProject(state.conn, ws.project_id)!
    const cp = body.checkpoint_id ? repo.getCheckpoint(state.conn, body.checkpoint_id) : repo.latestCheckpoint(state.conn, ws.id)
    if (cp === null) throw new HttpError(409, 'no checkpoint to verify; make one first')
    const configured = ((project.config.checks as unknown[] | undefined) ?? []).map((raw) => CheckConfigSchema.parse(raw))
    const checks: CheckConfig[] = configured.length ? configured : [...state.config.checks]
    if (!checks.length) return c.json({ checkpoint_id: cp.id, results: [], note: 'no checks configured for this project' })
    const results = await runChecks(state.conn, state.workspaces, state.processes, project, cp, { checks })
    recordHumanRun(state.conn, {
      session_id: ws.session_id, project_id: ws.project_id, workspace_id: ws.id, label: `checks (${connectorOf(c) ?? 'by hand'})`,
      text: `checks on ${cp.id}: ` + results.map((r) => `${r.check_id} ${r.status}`).join(', '),
      produced: { workspace_id: ws.id, base_commit: ws.base_commit, checkpoints: [cp.id], final_checkpoint_id: cp.id, checks: results.map((r) => r.id) },
      kind: 'verify', checks: checkCounts(results, checks.map((ch) => ch.id)),
    })
    return c.json({ checkpoint_id: cp.id, snapshot_id: cp.snapshot_id, results })
  })

  /** Compose chosen checkpoints onto their common base in an integration worktree, verify the composition, and
   *  write it into this workspace when the workspace still stands at that base (see workspace/integrate.ts). */
  app.post('/api/workspaces/:workspace_id/integrate', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'))
    const body = await parseBody(c, IntegrateBodySchema)
    // what its runs write is in the folder already: there is nothing to compose into it
    if (isDirect(ws)) throw new HttpError(409, "a folder edited in place is written by its runs directly: there is nothing to integrate into it")
    if (!body.checkpoint_ids.length) throw new HttpError(400, 'checkpoint_ids is required')
    const project = repo.getProject(state.conn, ws.project_id)!
    const protectedPaths = [...state.config.protected_paths, ...(((project.config.protected_paths as string[] | undefined) ?? []))]
    const locks = ws.session_id ? effectiveLocks(state.conn, ws.session_id, project) : []
    // composed and written as the folder's writer: nobody starts writing it between the check and the write
    const payload = await underFolderLock(state, ws.id, 'integrate',
      () => integrate(state, ws, body.checkpoint_ids, { run_id: null, note: body.note, protected: protectedPaths, verify: body.verify, locks }),
      (h) => `integrate ${holderEnds(h)}`)
    recordHumanRun(state.conn, {
      session_id: ws.session_id, project_id: ws.project_id, workspace_id: ws.id, label: `integration (${connectorOf(c) ?? 'by hand'})`,
      text: `integration of ${body.checkpoint_ids.join(', ')}: ${payload.status}` + (payload.reason ? ` — ${payload.reason}` : ''),
      produced: {
        workspace_id: ws.id, base_commit: payload.base_commit, checkpoints: payload.composed_checkpoint_id ? [payload.composed_checkpoint_id] : [],
        final_checkpoint_id: payload.composed_checkpoint_id, tree_sha: payload.tree_sha, files_changed: payload.files.map((f) => f.path).slice(0, 200),
        checks: payload.checks.map((ch) => ch.id),
      },
      kind: 'integrate', checks: checkCounts(payload.checks as { status: string; check_id?: string }[], configuredCheckIds(state, project)),
    })
    return c.json(payload)
  })

  // a command in the session's folder, run as an agent's bash runs it — the sandbox, the session's grants and network,
  // the locks, the logs — for a client that works the folder itself (the connector); the session's mode holds: Plan
  // runs none, "ask before changes" is the person's to answer in the app, so it is refused here rather than held
  app.post('/api/workspaces/:workspace_id/commands', async (c) => {
    const ws = requireWorkspace(state, c.req.param('workspace_id'), true)
    const body = await parseBody(c, CommandBodySchema)
    const project = repo.getProject(state.conn, ws.project_id)
    // the session the command runs under: the folder's own (as before access modes), or — asking for the session's
    // access (director.v6) — the one named, which must work in this folder, else the only one that does: a folder
    // edited in place is shared by its sessions, and a command never borrows another session's access or permissions
    let session = ws.session_id ? repo.getSession(state.conn, ws.session_id) : null
    if (body.access === 'session' && body.command) {
      const working = repo.sessionsOfWorkspace(state.conn, ws.id)
      if (body.session_id) {
        session = working.find((s) => s.id === body.session_id) ?? null
        if (session === null) throw new HttpError(403, `session ${body.session_id} does not work in this folder`, 'session_not_in_workspace')
      } else if (working.length === 1) session = working[0]!
      // several: none is chosen for the caller — the candidates are named, with how to go on
      else if (working.length > 1) throw new HttpError(409, `${working.length} sessions work in this folder (${working.map((s) => s.id).join(', ')}): name the session_id the command runs under`, 'session_ambiguous',
        { candidates: working.map((s) => ({ session_id: s.id, title: s.title, access_mode: s.access_mode })), next_step: 'send the command again with session_id set to one of the candidates' })
      else session = null
    }
    if (session === null || project === null) throw new HttpError(409, 'this working folder belongs to no session')
    if (body.execution_id) {
      const execution = repo.getExecution(state.conn, body.execution_id)
      if (execution === null || execution.workspace_id !== ws.id) throw new HttpError(404, `no command ${body.execution_id} in this working folder`)
      await state.processes.wait(execution.id, body.wait_s)
      const summary = await state.processes.summaryAsync(execution.id)
      return c.json(state.processes.isRemoteExecution(execution.id) ? summary : { ...summary, status: summary.running ? 'running' : summary.status })
    }
    const control = effectiveControl(state.conn, session.id)
    if (!allowsAgentEffect(inferMode(session.grants, control), 'isolated_code_execution') || !session.grants.run_commands) {
      throw new HttpError(409, 'the session runs no commands (Plan mode, or commands not granted); the user changes that in oasis-code')
    }
    if (shouldGate(new Set(['isolated_code_execution']), control)) {
      throw new HttpError(409, 'the session asks the user before a command runs; the user answers in oasis-code, or changes its mode there')
    }
    // the cwd as the chosen session reaches it: its own roots, never another session's of a shared folder
    const policy = readPolicy(state, ws, [session.id])
    // read_only (director.v6, or the person's own client): a command the OS holds to reading the folder — never a
    // writer, so it runs beside one; a surface v1–v5 describes no such command and is not given one
    const surface = (c.req.header(TOOL_SURFACE_HEADER) ?? '').trim()
    const readOnly = body.read_only === true
    if (readOnly && surface && surfaceCap(surface) === 'sandbox') {
      throw new HttpError(400, `read_only is not a field of tool surface ${surface}: send the command without it (it runs as a writer), or from director.v6`, 'read_only_unsupported')
    }
    // a command that may write writes the folder as a run does: one writer at a time (a run of it, an approval,
    // another command — and the commands a writer left running, until they exit)
    const owner = `command:${newId('cmd')}`
    if (readOnly) state.locks.addReader(ws.id, owner, { session_id: session.id })
    else {
      const offer = !surface || surfaceCap(surface) !== 'sandbox'
      try {
        state.locks.acquireNow(ws.id, owner, { kind: 'command', session_id: session.id, operation: 'command' },
          (h) => `run the command ${holderEnds(h)}${offer ? '; a command that only reads can run now with read_only: true' : ''}`)
      } catch (error) {
        if (error instanceof WorkspaceBusy) throw busyHttp(error)
        throw error
      }
    }
    const request = currentRequestCap()
    let payload: Awaited<ReturnType<typeof executeCommand>>[0]
    // the lease of a command still running when its wait ends: held (or listed, read-only) until it really ended
    let leased = false
    try {
      const options: RouteCommandOptions = {
        processes: state.processes, workspaces: state.workspaces, config: state.config, project, workspace: ws, policy,
        locks: effectiveLocks(state.conn, session.id, project), run_id: null, tool_call_id: null, command: body.command!, launched_by: 'connector',
        timeout_s: body.timeout_s ?? null, wait_s: body.wait_s, network: commandNetwork(session.grants, null), cwd: body.cwd ?? null,
        // the roots of the session the command runs under (the one chosen above, never another session of the folder),
        // as this workspace holds them (read-only in an isolated copy: workspace/roots.ts policyRoots)
        roots: policyRoots(session, ws),
        // at the start, after the folder's lock and adoption: the session still runs commands without asking (else
        // nothing runs), its network as it is then, and the sandbox — as this route always ran it — unless the caller
        // asks for the session's access (director.v6); the request's own cap (a surface v1–v5, a connector's client of
        // none) narrows that again
        decide: () => {
          const refused = commandRefusedNow(state.conn, session.id)
          if (refused !== null) return { refused }
          const now = repo.getSession(state.conn, session.id)!
          const network = commandNetwork(now.grants, null)
          // the route's own sandbox, said as such (route_sandbox), unless the session's access is asked for
          if (body.access !== 'session') return { network, access: 'sandbox', requested_access: 'sandbox', access_reasons: [reason('route_sandbox')] }
          const decided = accessDecision({ session: now, request })
          return { network, access: decided.effective, requested_access: decided.requested, access_reasons: decided.reasons }
        },
        // the result carries what was refused (attachment_access_refused); the connector reads it there
        input_files: sessionInputFiles(state.conn, state.store, state.settings.data_dir, session),
        // whoever waits for the folder, or looks, is told which command holds it
        on_started: (execution) => { if (readOnly) state.locks.setReaderExecution(ws.id, owner, execution.id); else state.locks.annotate(ws.id, owner, { execution_id: execution.id }) },
        ...(readOnly ? { read_only: true } : {}),
      }
      ;[payload] = await executeCommand(options)
      const xid = typeof payload.execution_id === 'string' ? payload.execution_id : null
      if ((payload.status === 'running' || payload.running === true) && xid !== null) {
        // its wait ended, the command did not: the folder stays held until it has really ended (wait(…, null) is
        // already settled when it ended meanwhile — the lease then goes on the next turn, never kept)
        const ended = state.processes.wait(xid, null)
        if (readOnly) { void ended.finally(() => state.locks.removeReader(ws.id, owner)); leased = true }
        else leased = state.locks.holdUntil(ws.id, owner, xid, ended)
      }
    } finally {
      if (readOnly) { if (!leased) state.locks.removeReader(ws.id, owner) }
      else state.locks.release(ws.id, owner)
    }
    if (payload.status === 'refused') {
      // what the execution layer said of it (access asked for and given, its reasons, the next step) goes with the
      // refusal; a restriction asked for that this machine cannot enforce is a conflict to resolve, not a bad request
      const extra = Object.fromEntries(['requested_access', 'effective_access', 'access_reasons', 'restrictions', 'isolation', 'next_step', 'attachment_access_refused']
        .filter((k) => payload[k] !== undefined).map((k) => [k, payload[k]]))
      const code = typeof payload.code === 'string' ? payload.code : null
      throw new HttpError(code === 'restriction_unavailable' ? 409 : 400, String(payload.reason), code, Object.keys(extra).length ? extra : null)
    }
    payload = { ...payload, workspace_lane: readOnly ? 'read_only' : 'writer', ...(payload.status === 'running' && !readOnly ? { holds_workspace_until_exit: leased } : {}) }
    // the person sees it in the session, as their own action through the connector
    recordHumanRun(state.conn, {
      session_id: session.id, project_id: project.id, workspace_id: ws.id, label: `command (${connectorOf(c) ?? 'connector'})`, kind: 'command',
      text: `$ ${body.command}\n→ ${payload.status === 'running' ? `running (${String(payload.execution_id)})` : `exit ${String(payload.exit_code)}`}`,
      produced: { workspace_id: ws.id, executions: [payload.execution_id] },
    })
    return c.json(payload)
  })

  app.get('/api/executions/:execution_id', async (c) => {
    const xid = c.req.param('execution_id')
    const x = repo.getExecution(state.conn, xid)
    if (x === null) throw new HttpError(404, `execution not found: ${xid}`)
    if (state.processes.isRemoteExecution(xid)) return c.json({ ...x, ...await state.processes.summaryAsync(xid), isolation: x.isolation })
    return c.json({ ...x, running: state.processes.isRunning(xid) })
  })

  app.get('/api/executions/:execution_id/output', async (c) => {
    const xid = c.req.param('execution_id')
    try {
      return c.json(await state.processes.readOutputAsync(xid, c.req.query('stream') ?? 'stdout', intQuery(c, 'offset', 0), intQuery(c, 'limit', 65536)))
    } catch (error) {
      if ((error as Error).name === 'NotFound' || /not found|unknown execution/i.test((error as Error).message)) throw new HttpError(404, `execution not found: ${xid}`)
      throw error
    }
  })

  app.post('/api/executions/:execution_id/stop', async (c) => c.json(await state.processes.stopAsync(c.req.param('execution_id'))))

  app.get('/api/assets/:asset_id', (c) => {
    const assetId = c.req.param('asset_id')
    const asset = repo.getAsset(state.conn, assetId)
    if (asset === null) throw new HttpError(404, `asset not found: ${assetId}`)
    let bytes: Buffer
    try {
      bytes = state.store.read(asset.storage_path)
    } catch (error) {
      // the record stands but its file is gone: the evidence is unavailable, which is no fault of the server's
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(410, `evidence unavailable: the file of asset ${assetId} is gone`)
      throw error
    }
    return c.text(bytes.toString('utf8'))
  })

  return app
}
