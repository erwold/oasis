/** Intelligent UI's routes (contract/src/ui.ts, contract/src/ui_interaction.ts): the session's surfaces, the person's
 *  values, the draft actions they prepare, the tasks their `run` actions start, and the answers to request_input's
 *  forms. Behind the same session token as every other route; a surface, a task and a form are reached only through
 *  the session they belong to. A draft action is prepared (a receipt and a prompt for the draft), never run. */

import type { Context } from 'hono'
import { Hono } from 'hono'
import {
  checkUiJson, checkUiTaskJson, UI_TASK_LIMITS, UiActionBodySchema, UiInputDismissBodySchema, UiInputListQuerySchema,
  UiChartSourceQuerySchema, UiInputSubmitBodySchema, UiStateBodySchema, UiTaskBodySchema, UiTaskListQuerySchema, z,
} from '@oasis-code/contract'
import * as repo from '../db/repo.ts'
import { readChartSourcePage } from '../agent/ui_chart_sources.ts'
import { answerInput, ownedInput } from '../agent/ui_inputs.ts'
import { MAX_UI_BODY_BYTES, prepareAction, saveSurfaceState, UiError } from '../agent/ui_surfaces.ts'
import { HttpError, type Api } from './common.ts'
import { requireSession } from './state.ts'

/** The body's text, read as it streams and only up to `maxBytes` UTF-8 bytes: a Content-Length past the bound is
 *  refused before any of it is read; a body that streams past it (chunked, or a length that lied) is cancelled at the
 *  chunk that crosses it. Invalid UTF-8 is a 422. */
export async function readBoundedBody(req: Request, maxBytes: number): Promise<string> {
  const declared = req.headers.get('content-length')
  if (declared !== null && declared !== '' && Number(declared) > maxBytes) throw new UiError(413, 'too_large', `the body is larger than ${maxBytes} bytes`)
  if (req.body === null) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new UiError(413, 'too_large', `the body is larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new HttpError(422, 'the request body is not UTF-8')
  }
}

/** A bounded body (readBoundedBody), JSON, its shape (reserved keys refused by name, depth and size bounded — the
 *  schema would silently drop a `__proto__`), then its schema (422 as parseBody says it). */
async function boundedBody<S extends z.ZodType>(c: Context, schema: S, check: (raw: unknown) => void = defaultShape): Promise<z.infer<S>> {
  const text = await readBoundedBody(c.req.raw, MAX_UI_BODY_BYTES)
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new HttpError(422, 'the request body is not JSON') }
  check(raw)
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new HttpError(422, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '))
  return parsed.data
}

function defaultShape(raw: unknown, code = 'invalid_state'): void {
  const shape = checkUiJson(raw, 8)
  if (shape !== null) throw new UiError(400, code, shape, { errors: [shape] })
}

/** A task's body: its `input` is bounded as the contract bounds it (its own nesting and size, named invalid_input);
 *  the rest as any state body. */
function taskShape(raw: unknown): void {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && Object.hasOwn(raw, 'input')) {
    const { input, ...rest } = raw as Record<string, unknown>
    const bad = checkUiTaskJson(input, 'input')
    if (bad !== null) throw new UiError(400, 'invalid_input', bad, { errors: [bad] })
    defaultShape(rest)
    return
  }
  defaultShape(raw)
}

/** A query string read by its schema (422 as a body's). */
function query<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query())
  if (!parsed.success) throw new HttpError(422, parsed.error.issues.map((i) => `${i.path.join('.') || 'query'}: ${i.message}`).join('; '))
  return parsed.data
}

function refusal(c: Context, error: unknown): Response {
  if (error instanceof UiError) return c.json({ detail: error.message, error: error.code, ...error.extra }, error.status)
  throw error
}

export function uiRoutes(api: Api): Hono {
  const app = new Hono()
  const { state } = api

  app.get('/api/sessions/:session_id/ui', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    return c.json({ surfaces: repo.listUiSurfaces(state.conn, session.id) })
  })

  app.put('/api/sessions/:session_id/ui/:run_id/:surface_id/state', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    try {
      const body = await boundedBody(c, UiStateBodySchema)
      return c.json({ surface: saveSurfaceState(state.conn, session.id, c.req.param('run_id'), c.req.param('surface_id'), body) })
    } catch (error) {
      return refusal(c, error)
    }
  })

  app.post('/api/sessions/:session_id/ui/:run_id/:surface_id/actions', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    try {
      const body = await boundedBody(c, UiActionBodySchema)
      return c.json(prepareAction(state.conn, session.id, c.req.param('run_id'), c.req.param('surface_id'), body))
    } catch (error) {
      return refusal(c, error)
    }
  })

  // a chart's file source, a page at a time (agent/ui_chart_sources.ts: read under the writing run's read bounds)
  app.get('/api/sessions/:session_id/ui/:run_id/:surface_id/sources/:element_id', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const q = query(c, UiChartSourceQuerySchema)
    try {
      const page = await readChartSourcePage(state, session.id, c.req.param('run_id'), c.req.param('surface_id'), c.req.param('element_id'), q)
      c.header('cache-control', 'no-store')
      return c.json(page)
    } catch (error) {
      return refusal(c, error)
    }
  })

  // -- UI tasks (a surface's `run` actions) ---------------------------------------------------------------------------

  app.post('/api/sessions/:session_id/ui/:run_id/:surface_id/tasks', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    try {
      const body = await boundedBody(c, UiTaskBodySchema, taskShape)
      const { created, response } = state.ui_tasks.startTask(session.id, c.req.param('run_id'), c.req.param('surface_id'), body)
      return c.json(response, created ? 202 : 200)
    } catch (error) {
      return refusal(c, error)
    }
  })

  app.get('/api/sessions/:session_id/ui-tasks', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const q = query(c, UiTaskListQuerySchema)
    const active = q.active === '1' || q.active === 'true'
    return c.json({ tasks: repo.listUiTasks(state.conn, session.id, { surface_run_id: q.run_id, surface_id: q.surface_id, active, limit: UI_TASK_LIMITS.list }) })
  })

  app.get('/api/sessions/:session_id/ui-tasks/:task_id', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    try {
      return c.json({ task: state.ui_tasks.ownedTask(session.id, c.req.param('task_id')) })
    } catch (error) {
      return refusal(c, error)
    }
  })

  app.post('/api/sessions/:session_id/ui-tasks/:task_id/cancel', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    try {
      // `{}` (or nothing): the request names the task in its path
      const text = await readBoundedBody(c.req.raw, MAX_UI_BODY_BYTES)
      if (text.trim() !== '') {
        let raw: unknown
        try { raw = JSON.parse(text) } catch { throw new HttpError(422, 'the request body is not JSON') }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(422, 'body: an object')
      }
      const { status, task } = state.ui_tasks.cancelTask(session.id, c.req.param('task_id'))
      return c.json({ task }, status)
    } catch (error) {
      return refusal(c, error)
    }
  })

  // -- request_input's forms -------------------------------------------------------------------------------------------

  app.get('/api/sessions/:session_id/ui-inputs', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    const q = query(c, UiInputListQuerySchema)
    return c.json({ inputs: repo.listUiInputs(state.conn, session.id, { run_id: q.run_id, status: q.status, limit: 50 }) })
  })

  app.get('/api/sessions/:session_id/ui-inputs/:input_id', (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    try {
      return c.json({ input: ownedInput(state.conn, session.id, c.req.param('input_id')) })
    } catch (error) {
      return refusal(c, error)
    }
  })

  app.post('/api/sessions/:session_id/ui-inputs/:input_id/submit', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    try {
      const body = await boundedBody(c, UiInputSubmitBodySchema, (raw) => defaultShape(raw, 'invalid_values'))
      return c.json({ input: answerInput(state.conn, session.id, c.req.param('input_id'), { kind: 'submit', values: body.values, ...(body.request_id !== undefined ? { request_id: body.request_id } : {}) }) })
    } catch (error) {
      return refusal(c, error)
    }
  })

  app.post('/api/sessions/:session_id/ui-inputs/:input_id/dismiss', async (c) => {
    const session = requireSession(state, c.req.param('session_id'))
    try {
      const body = await boundedBody(c, UiInputDismissBodySchema)
      return c.json({ input: answerInput(state.conn, session.id, c.req.param('input_id'), { kind: 'dismiss', ...(body.request_id !== undefined ? { request_id: body.request_id } : {}) }) })
    } catch (error) {
      return refusal(c, error)
    }
  })

  return app
}
