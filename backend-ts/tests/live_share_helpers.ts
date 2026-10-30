/** Helpers of the live share's tests: an app whose share listener binds an ephemeral port (projection in process unless
 *  a test asks for the worker), a viewer that reads the stream frame by frame, a run that is "live" as the runner's
 *  handle would be (its events in memory, the persisted ones written, the hub told). Synthetic data only. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LiveStateFrameSchema, type LiveStateFrame } from '@oasis-code/contract'
import * as repo from '../src/db/repo.ts'
import type { App } from '../src/main.ts'
import type { LiveShareServiceOptions } from '../src/share/live/service.ts'
import type { Settings } from '../src/config.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { buggyRepo } from './harness.ts'
import { tempDir } from './helpers.ts'

export const FAST: LiveShareServiceOptions = { projector: 'inline', test_port: 0, debounce_ms: 10, min_interval_ms: 20, poll_ms: 40, idle_ms: 60 }

export function viewerDir(): string {
  const dir = join(tempDir('oasis-live-viewer-'), 'live-share')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'live-share.js'), 'console.log("synthetic viewer")\n')
  writeFileSync(join(dir, 'live-share.css'), 'body{margin:0}\n')
  return dir
}

export async function liveApp(opts: LiveShareServiceOptions = {}, settings?: Settings): Promise<App> {
  return makeApp(settings ?? null, { live_share: { ...FAST, viewer_dir: viewerDir(), ...opts } })
}

export const local = (app: App) => new Client(app, { ip: '127.0.0.1' })

export async function enable(app: App, over: Record<string, unknown> = {}): Promise<number> {
  await json(await local(app).put('/api/settings/live-share', { enabled: true, bind: 'loopback', port: 8325, public_base_url: null, ...over }))
  const port = app.state.live_share!.listeningPort
  if (port === null) throw new Error('the share listener did not bind')
  return port
}

export async function openSession(app: App, title = 'Live demo'): Promise<ReturnType<typeof repo.getSession> & {}> {
  const c = new Client(app)
  const project = await json(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json(await c.post(`/api/projects/${project.id}/sessions`, { title }))
  return repo.getSession(app.state.conn, session.id as string)!
}

export async function makeLink(app: App, sessionId: string, body: Record<string, unknown> = {}): Promise<{ id: string; capability: string; url: string | null }> {
  const r = await json<{ link: { id: string }; capability: string; url: string | null }>(await local(app).post(`/api/sessions/${sessionId}/share-links`, body), 201)
  return { id: r.link.id, capability: r.capability, url: r.url }
}

export interface Frame { event: string; id: string | null; data: string }

/** One viewer's stream, read as it comes. */
export class Viewer {
  readonly frames: Frame[] = []
  ended = false
  status = 0
  private buf = ''
  private reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } | null = null

  static async open(port: number, capability: string, read = true): Promise<Viewer> {
    const v = new Viewer()
    const res = await fetch(`http://127.0.0.1:${port}/live/api/stream`, { headers: { authorization: `Bearer ${capability}` } })
    v.status = res.status
    if (res.status !== 200 || !res.body) { v.ended = true; v.buf = await res.text(); return v }
    v.reader = res.body.getReader()
    if (read) void v.pump()
    return v
  }

  async pump(): Promise<void> {
    const dec = new TextDecoder()
    for (;;) {
      let r: { done: boolean; value?: Uint8Array }
      try { r = await this.reader!.read() } catch { this.ended = true; return }
      if (r.done) { this.ended = true; return }
      this.buf += dec.decode(r.value, { stream: true })
      let at: number
      while ((at = this.buf.indexOf('\n\n')) >= 0) {
        const block = this.buf.slice(0, at)
        this.buf = this.buf.slice(at + 2)
        if (block.startsWith(':')) continue
        let event = 'message'; let id: string | null = null; let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('id: ')) id = line.slice(4)
          else if (line.startsWith('data: ')) data += line.slice(6)
        }
        this.frames.push({ event, id, data })
      }
    }
  }

  get body(): string { return this.buf }
  states(): LiveStateFrame[] { return this.frames.filter((f) => f.event === 'state').map((f) => LiveStateFrameSchema.parse(JSON.parse(f.data))) }
  last(): LiveStateFrame | null { return this.states().at(-1) ?? null }
  endedWith(): string | null { const f = this.frames.find((x) => x.event === 'ended'); return f ? (JSON.parse(f.data) as { reason: string }).reason : null }

  async until(pred: (v: Viewer) => boolean, ms = 5000): Promise<void> {
    const start = Date.now()
    while (!pred(this)) {
      if (Date.now() - start > ms) throw new Error(`timed out; frames: ${this.frames.map((f) => f.event).join(',')} ended=${this.ended}`)
      await Bun.sleep(10)
    }
  }

  close(): void { void this.reader?.cancel().catch(() => {}) }
}

/** A run that works now, as the runner holds it: a row (running), a handle with its events, the hub told of each. */
export function liveRun(app: App, session: { id: string; project_id: string; workspace_id: string | null }, userText = 'please do the thing') {
  const conn = app.state.conn
  const run = repo.insertRun(conn, {
    session_id: session.id, project_id: session.project_id, workspace_id: session.workspace_id, model: 'scripted:a', model_config: {}, user_text: userText, status: 'running', budget: {},
    resumes_run_id: null, attachments: [] as never, spawned_by: 'human', relay_id: null, relay_step: null,
  })
  const events: { seq: number; event: string; data: Record<string, unknown>; v: number; run_id: string; cursor: number | null }[] = []
  const handle = { run_id: run.id, session_id: session.id, done: false, status: 'running', events }
  app.state.runs.handles.set(run.id, handle as never)
  const TRANSIENT = new Set(['text_delta', 'thinking_delta', 'tool_call_progress'])
  return {
    id: run.id,
    emit(event: string, data: Record<string, unknown>) {
      const item = { seq: events.length, event, data, v: 1, run_id: run.id, cursor: null as number | null }
      events.push(item)
      if (!TRANSIENT.has(event)) item.cursor = repo.insertEvent(conn, run.id, item.seq, event, data)
      app.state.runs.sessions.publish(session.id, item)
    },
    finish(status = 'done') {
      handle.done = true
      app.state.runs.handles.delete(run.id)
      repo.finishRun(conn, run.id, status, { history_json: null, usage: {}, error: null, receipt: {}, saved_seq: events.length })
      app.state.runs.sessions.publish(session.id, { seq: events.length, event: 'run_finished', data: {}, run_id: run.id, cursor: null })
    },
    drop() { handle.done = true; app.state.runs.handles.delete(run.id) },
  }
}
