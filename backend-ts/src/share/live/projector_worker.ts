/** The live share's projector thread (projector.ts WorkerProjector): the expensive part of a live state — reading a
 *  session's rows at one cut, parsing its records, projecting and sanitizing, stripping pictures, validating and
 *  serializing — off the app's event loop. It opens the database READ-ONLY and builds no app state: what it gets is
 *  the paths, the model labels and the session token (for the sanitizer only; never logged, never sent back).
 *
 *  The message handler is set first, before anything else (Bun queues nothing for a handler set after a top-level
 *  await); requests are answered one at a time, in order. Replies carry no error text. */

import { ProjectorCore, type ImageRequest, type PartRequest, type ProjectorInit, type ProjectRequest } from './projector_core.ts'

declare const self: Worker

type Inbound =
  | { type: 'init'; init: ProjectorInit }
  | { type: 'project'; id: number; req: ProjectRequest }
  | { type: 'image'; id: number; req: ImageRequest }
  | { type: 'part'; id: number; req: PartRequest }
  | { type: 'close' }

let core: ProjectorCore | null = null
/** the request being answered: the graph's stand-in marks ITS session's watched runs live (one session per request) */
let current: ProjectRequest | PartRequest | null = null

self.onmessage = (event: MessageEvent<Inbound>) => {
  const m = event.data
  if (m.type === 'init') {
    try {
      core = ProjectorCore.open(m.init, () => current?.runs ?? [], () => current?.session_id ?? '')
      self.postMessage({ type: 'ready' })
    } catch {
      self.postMessage({ type: 'failed' })
    }
    return
  }
  if (m.type === 'close') { try { core?.close() } catch { /* closing */ } core = null; process.exit(0) }
  if (core === null) { self.postMessage({ type: 'reply', id: m.id, reply: m.type === 'project' || m.type === 'part' ? { ok: false, code: 'error' } : { ok: false } }); return }
  if (m.type === 'part') {
    current = m.req
    let reply
    try { reply = core.projectPart(m.req) } catch { reply = { ok: false as const, code: 'error' as const } } finally { current = null }
    if (reply.ok) self.postMessage({ type: 'reply', id: m.id, reply }, [reply.part.buffer as ArrayBuffer])
    else self.postMessage({ type: 'reply', id: m.id, reply })
    return
  }
  if (m.type === 'project') {
    current = m.req
    let reply
    try { reply = core.project(m.req) } catch { reply = { ok: false as const, code: 'error' as const } } finally { current = null }
    if (reply.ok) self.postMessage({ type: 'reply', id: m.id, reply }, [reply.snapshot.buffer as ArrayBuffer])
    else self.postMessage({ type: 'reply', id: m.id, reply })
    return
  }
  if (m.type === 'image') {
    let reply
    try { reply = core.image(m.req) } catch { reply = { ok: false as const } }
    if (reply.ok) self.postMessage({ type: 'reply', id: m.id, reply }, [reply.bytes.buffer as ArrayBuffer])
    else self.postMessage({ type: 'reply', id: m.id, reply })
  }
}
