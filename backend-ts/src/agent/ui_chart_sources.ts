/** A chart's file source, read for the person's client (GET …/ui/:run_id/:surface_id/sources/:element_id; contract
 *  UiChartSourceSchema, UiChartSourcePageSchema). Only reads: one page of bytes, the anchors, and on request the
 *  CRC-32 of the prefix — never a write, never a command, never through the model.
 *
 *  Who may read what: the path is the one the surface's current revision names, resolved again at every request under
 *  the read bounds of the run that wrote that revision (updated_by_run_id; for a run surface its own run): that run's
 *  workspace (not the session's: a task in an isolated copy reads its copy), its session's roots, its workspace's
 *  temporary folder, the protected paths and a work order's read scope — what the run's own read_file could read, now.
 *  A local file is opened without following a link and checked to be the file the path still resolves to; an SSH
 *  workspace's file is read through that workspace's own connection and root binding (files.resolve, then the
 *  adapter's read-only files.tail), never the connection the UI happens to show. */

import { constants, statSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import {
  parseUiSurfaceSpec, UI_CHART_SOURCE_LIMITS, uiSurfaceUpdatedBy, uiFileSource,
  type Run, type UiTaskExecution, type UiChartSource, type UiChartSourcePage, type UiChartSourceQuery, type Workspace,
} from '@oasis-code/contract'
import type { AppState } from '../api/state.ts'
import * as repo from '../db/repo.ts'
import { RemoteError } from '../remote/types.ts'
import { PathPolicy, PathRefused } from '../workspace/paths.ts'
import { RemoteRefused } from '../workspace/remote.ts'
import { remoteBinding } from '../workspace/remote_files.ts'
import { rootPolicyOptions } from '../workspace/roots.ts'
import { isDirect, workspaceAttached } from '../workspace/service.ts'
import { checkRevision, ownedSurface, UiError } from './ui_surfaces.ts'
import { orderRefusal, parseWorkOrder } from './work_orders.ts'

const ANCHOR = UI_CHART_SOURCE_LIMITS.anchorBytes
/** what one read of the prefix's CRC takes at a time */
const CRC_CHUNK = 1024 * 1024
/** how long a request waits for an SSH connection to come back (the client asks again after a failure) */
const REMOTE_WAIT_MS = 5_000

type Page = UiChartSourcePage

/** The page of a surface's chart source the query asks for. UiError for what the person's client cannot have (another
 *  revision, no such element, a path the writing run may not read, the connection unavailable). checkPath is an
 *  internal extra refusal (share classification), applied to both requested and actually opened canonical paths. */
export async function readChartSourcePage(state: Pick<AppState, 'conn' | 'config' | 'processes' | 'workspaces'>, sessionId: string, runId: string, surfaceId: string, elementId: string, q: UiChartSourceQuery, checkPath?: (path: string, workspace: Workspace) => void): Promise<Page> {
  const surface = ownedSurface(state.conn, sessionId, runId, surfaceId)
  checkRevision(surface, q.revision)
  const parsed = parseUiSurfaceSpec(surface.spec)
  if (!parsed.ok) throw new UiError(409, 'unsupported_spec', `this surface's spec cannot be read on this build (${parsed.errors[0] ?? 'unknown'})`)
  const el = parsed.value.elements?.[elementId]
  if (!el || !Object.hasOwn(parsed.value.elements!, elementId) || uiFileSource(el) === undefined) throw new UiError(404, 'not_found', `no element with a file source: ${elementId}`)
  const source = uiFileSource(el)!
  const writer = repo.getRun(state.conn, uiSurfaceUpdatedBy(surface))
  if (writer === null || writer.session_id !== sessionId) throw new UiError(404, 'not_found', 'the run that wrote this surface is not of this session')
  const ws = writer.workspace_id === null ? null : repo.getWorkspace(state.conn, writer.workspace_id)
  if (ws === null) throw new UiError(404, 'not_found', "the writing run's workspace is gone")
  const order = writer.work_order ? parseWorkOrder(writer.work_order) : null
  const limit = Math.min(q.limit ?? UI_CHART_SOURCE_LIMITS.pageBytes, UI_CHART_SOURCE_LIMITS.pageBytes)
  const verify = q.verify === '1'
  const check = checkPath ? (path: string) => checkPath(path, ws) : undefined
  check?.(source.path)
  // Capture command state BEFORE reading: an exit that races the file read requires another poll to drain it.
  const execution = source.progress?.execution_id ? taskExecution(state, writer, ws, source.progress.execution_id) : undefined
  try {
    const page = ws.target?.kind === 'ssh'
      ? await remotePage(state, ws, order, source, q.offset, limit, verify, check)
      : await localPage(readPolicyOf(state, writer, ws, order), order, source.path, q.offset, limit, verify, check)
    return execution ? { ...page, execution } : page
  } catch (error) {
    if (execution && error instanceof UiError && error.status === 503) return { status: 'unavailable', reason: error.message, execution }
    throw error
  }
}

/** Same command ownership as bash_output/watch; no output or command text crosses this endpoint. */
function taskExecution(state: Pick<AppState, 'conn' | 'processes'>, writer: Run, ws: Workspace, id: string): UiTaskExecution {
  const e = repo.getExecution(state.conn, id)
  if (!e || !(e.run_id === writer.id || e.workspace_id === ws.id
    || (e.run_id !== null && repo.getRun(state.conn, e.run_id)?.session_id === writer.session_id)
    || (e.workspace_id !== null && repo.getWorkspace(state.conn, e.workspace_id)?.session_id === writer.session_id))) {
    throw new UiError(403, 'refused', 'the writing run cannot read this command')
  }
  const status = e.status === 'succeeded' ? 'succeeded'
    : e.status === 'cancelled' ? 'cancelled'
    : e.status === 'failed' || e.status === 'timeout' ? 'failed'
    : e.status === 'lost' || e.status === 'unknown' || e.status === 'exited' ? 'unknown'
    : state.processes.isRemoteExecution(id) && !state.processes.remoteConnected(id) ? 'unknown' : 'running'
  return { status, exit_code: e.exit_code }
}

/** The path policy the writing run read under (runner.ts builds the run's own the same way), read-only. */
function readPolicyOf(state: Pick<AppState, 'conn' | 'config' | 'processes'>, run: Run, ws: Workspace, order: ReturnType<typeof parseWorkOrder> | null): PathPolicy {
  const project = repo.getProject(state.conn, ws.project_id)
  const session = repo.getSession(state.conn, run.session_id)
  const protectedPaths = [...state.config.protected_paths, ...(((project?.config.protected_paths as string[] | undefined) ?? [])), ...(order !== null ? order.protected_paths : [])]
  return PathPolicy.forWorkspace(ws.path, protectedPaths, project ? workspaceAttached(project, ws) : null, {
    temp: state.processes.ensureTemp(ws.id), pinned: isDirect(ws), ...rootPolicyOptions(session, ws),
  })
}

function refusedByOrder(order: ReturnType<typeof parseWorkOrder> | null, path: string, temp: boolean): void {
  const reason = orderRefusal(order, 'present_ui', 'read', temp ? { path: null, temp: true } : { path })
  if (reason !== null) throw new UiError(403, 'refused', reason)
}

/** The reads are asynchronous, a bounded chunk each (the prefix's CRC of a long file included): the server answers
 *  other requests between them. */
export async function localPage(policy: PathPolicy, order: ReturnType<typeof parseWorkOrder> | null, path: string, offset: number, limit: number, verify: boolean, checkPath?: (path: string) => void): Promise<Page> {
  let real: string
  try {
    const pure = policy.normalize(path)
    refusedByOrder(order, path, policy.isTemp(pure))
    real = policy.resolveRead(path)[1]
    checkPath?.(real)
    // and on what it resolved to, at every request (a link may be pointed elsewhere after the surface was presented)
    const canonical = policy.canonicalOf(real)
    if (!canonical.temp) refusedByOrder(order, canonical.path ?? path, false)
  } catch (error) {
    if (error instanceof PathRefused) throw new UiError(403, 'refused', error.message)
    throw error
  }
  let fh: FileHandle
  try {
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 'missing', reason: `no file at ${path} yet` }
    if (code === 'ELOOP') throw new UiError(403, 'refused', `${path} is a link`)
    throw new UiError(503, 'unavailable', `${path} cannot be opened (${code ?? 'error'})`)
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new UiError(403, 'refused', `${path} is not a regular file`)
    // the path still leads to the file opened, and where it leads now is still in the order's scope: a folder on the way
    // swapped for a link between the first resolution and the open is caught here (the open follows it; this does not)
    let real2: string
    try { real2 = policy.resolveRead(path)[1] } catch (error) {
      if (error instanceof PathRefused) throw new UiError(403, 'refused', error.message)
      return { status: 'missing', reason: `${path} changed while it was opened` }
    }
    checkPath?.(real2)
    const canonical2 = policy.canonicalOf(real2)
    if (!canonical2.temp) refusedByOrder(order, canonical2.path ?? path, false)
    let again: ReturnType<typeof statSync>
    try { again = statSync(real2) } catch { return { status: 'missing', reason: `${path} changed while it was opened` } }
    if (again.dev !== st.dev || again.ino !== st.ino) return { status: 'missing', reason: `${path} changed while it was opened` }
    // everything below is read up to the size the file had now: what is appended meanwhile is the next page's
    const size = st.size
    const read = async (from: number, length: number, into?: Buffer): Promise<Buffer> => {
      const buf = into && into.length >= length ? into.subarray(0, length) : Buffer.alloc(Math.max(0, length))
      let got = 0
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, from + got)
        if (bytesRead <= 0) break
        got += bytesRead
      }
      return buf.subarray(0, got)
    }
    const head = await read(0, Math.min(ANCHOR, size))
    const anchor = offset <= size ? await read(Math.max(0, offset - ANCHOR), offset - Math.max(0, offset - ANCHOR)) : null
    const data = offset < size ? await read(offset, Math.min(limit, size - offset)) : Buffer.alloc(0)
    let crc: number | null = null
    if (verify && offset <= size) {
      crc = 0
      const chunk = Buffer.alloc(Math.min(CRC_CHUNK, offset))
      for (let at = 0; at < offset;) {
        const part = await read(at, Math.min(CRC_CHUNK, offset - at), chunk)
        if (!part.length) break
        crc = crc32(part, crc)
        at += part.length
      }
    }
    return {
      status: 'ok', file_id: `${st.dev}:${st.ino}`, size, mtime_ms: st.mtimeMs, offset, next_offset: offset + data.length, eof: offset + data.length >= size,
      data: data.toString('base64'), head: head.toString('base64'), anchor: anchor === null ? null : anchor.toString('base64'), crc,
    }
  } finally {
    await fh.close()
  }
}

async function remotePage(state: Pick<AppState, 'workspaces'>, ws: Workspace, order: ReturnType<typeof parseWorkOrder> | null, source: UiChartSource, offset: number, limit: number, verify: boolean, checkPath?: (path: string) => void): Promise<Page> {
  refusedByOrder(order, source.path, false)
  try {
    const files = state.workspaces.requireRemoteFiles()
    const root = remoteBinding(ws)
    const resolved = await files.resolve(ws, source.path, true, REMOTE_WAIT_MS)
    // The adapter tail rechecks this exact spelling and opens every component with O_NOFOLLOW.
    checkPath?.(resolved.path)
    // the order's scope is checked on the path as the host spells it too
    refusedByOrder(order, resolved.path, false)
    if (!resolved.exists) return { status: 'missing', reason: `no file at ${source.path} yet` }
    const tail = (params: { limit: number; anchor: number; crc_from?: number; crc_seed?: number }) => files.remote.request(root, 'files.tail',
      { path: resolved.path, byte_offset: offset, limit: params.limit, anchor_bytes: params.anchor, verify, ...(params.crc_from !== undefined ? { crc_from: params.crc_from, crc_seed: params.crc_seed ?? 0 } : {}) },
      undefined, { wait_ms: REMOTE_WAIT_MS })
    const p = await tail({ limit, anchor: ANCHOR })
    let crc = p.crc
    // the prefix's CRC in slices the adapter bounds, one request each: the channel serves other requests between them
    for (let next = p.crc_next; verify && crc !== null && next !== null && next < offset;) {
      const more = await tail({ limit: 0, anchor: 0, crc_from: next, crc_seed: crc })
      // another file at the path meanwhile: no CRC of one file (the client's check fails and it reads again)
      if (more.file_id !== p.file_id || more.crc === null || more.crc_next === null || more.crc_next <= next) { crc = -1; break }
      crc = more.crc
      next = more.crc_next
    }
    return {
      status: 'ok', file_id: p.file_id, size: p.size, mtime_ms: p.mtime_ms, offset: p.byte_offset, next_offset: p.next_offset, eof: p.eof,
      data: p.data, head: p.head, anchor: p.anchor, crc,
    }
  } catch (error) {
    if (error instanceof UiError) throw error
    const code = (error as { code?: string }).code ?? 'remote_unavailable'
    if (code === 'not_found' || (code === 'storage_failed' && (error as Error).message === 'FileNotFoundError')) return { status: 'missing', reason: `no file at ${source.path} yet` }
    if (error instanceof RemoteRefused || error instanceof RemoteError) {
      const definite = ['path_refused', 'path_not_canonical', 'root_changed', 'invalid_argument', 'capability_unavailable'].includes(code)
      throw new UiError(definite ? 403 : 503, definite ? 'refused' : 'unavailable', `${error.message} (${code})`)
    }
    throw error
  }
}
