/** Shared test helpers: a temp directory per test, a private auth store, a scripted fetch that plays a provider,
 *  and an agent run collected into its events and result. */

import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from '@oasis-code/contract'
import { Agent, type AgentEvent, type AgentRunResult, type Tool } from '../src/agent/loop.ts'
import { resetStores, setDefaultAuthDir } from '../src/auth/store.ts'
import type { FetchLike } from '../src/llm/http.ts'
import type { ModelMessage, UserContent } from '../src/llm/messages.ts'
import type { Model, ModelSettings } from '../src/llm/model.ts'
import { forgetTempDir, rememberTempDir, removeTestDir } from './temp_dirs.ts'

/** A fresh folder under the system's temp root; removed when the run ends if the test does not remove it first. */
export function tempDir(prefix = 'oasis-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  rememberTempDir(dir)
  return dir
}

export function removeDir(path: string): void {
  removeTestDir(path)
  forgetTempDir(path)
}

/** Point the process-wide credential store at a private directory (never the person's ~/.oasis-code). */
export function privateAuthDir(): { dir: string; done: () => void } {
  const dir = tempDir('oasis-auth-')
  setDefaultAuthDir(join(dir, 'private'))
  resetStores()
  return { dir, done: () => { setDefaultAuthDir(null); resetStores(); removeDir(dir) } }
}

export interface Recorded { url: string; headers: Headers; body: Record<string, unknown> }

/** A mock provider route: records every request, answers from a script of response bodies (the last repeats). */
export class Route {
  readonly requests: Record<string, unknown>[] = []
  readonly urls: string[] = []
  readonly headers: Headers[] = []
  status = 200

  constructor(public responses: (string | Uint8Array)[], readonly contentType = 'text/event-stream') {}

  fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    this.urls.push(url)
    this.headers.push(new Headers(init?.headers as Headers))
    this.requests.push(JSON.parse((init?.body as string) || '{}'))
    const i = Math.min(this.requests.length - 1, this.responses.length - 1)
    return new Response(this.responses[i], { status: this.status, headers: { 'content-type': this.contentType } })
  }
}

/** A tool over a zod schema (what the agent's tools look like in the tests). */
export function zodTool<D, S extends z.ZodType>(name: string, description: string, schema: S, fn: (deps: D, args: z.infer<S>) => unknown): Tool<D> {
  return {
    name, description, parameters_json_schema: z.toJSONSchema(schema) as Record<string, unknown>,
    validate: (args) => {
      const r = schema.safeParse(args)
      return r.success ? { value: r.data } : { error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
    },
    fn: (ctx, args) => fn(ctx.deps, args as z.infer<S>),
  }
}

export interface Collected { events: AgentEvent[]; result: AgentRunResult; texts: string[] }

export async function runAgent<D>(agent: Agent<D>, model: Model, prompt: UserContent | null, deps: D, opts: {
  history?: ModelMessage[] | null; settings?: ModelSettings
} = {}): Promise<Collected> {
  const events: AgentEvent[] = []
  let result: AgentRunResult | null = null
  for await (const event of agent.runStreamEvents({ prompt, deps, model, messageHistory: opts.history ?? null, modelSettings: opts.settings })) {
    events.push(event)
    if (event.type === 'result') result = event.result
  }
  const texts = events.filter((e) => e.type === 'part_delta' && e.delta.part_kind === 'text').map((e) => (e as { delta: { content_delta: string } }).delta.content_delta)
  return { events, result: result!, texts }
}

export function sse(events: [string, unknown][]): string {
  return events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')
}
