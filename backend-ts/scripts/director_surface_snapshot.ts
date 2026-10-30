/** Replays the snapshot of a director tool surface: everything a director conversation is sent on that surface — the
 *  connector's tool list (as MCP `tools/list` answers it) and instructions (as `initialize` gives them), the native
 *  director's tools (name, description, cleaned JSON schema) and system instructions, and the harness-written texts of
 *  the conversation (templates), with a golden rendering of a task event. Runtime never runs this: it reads the
 *  committed JSON (src/director/surfaces/director.vN.json); this script only shows where those bytes came from.
 *
 *    director.v1 — run against the baseline tree (main 3d06c7b, schema v24):
 *      git archive 3d06c7b backend-ts contract | tar -x -C $TMPDIR/base   (dependencies linked, never downloaded)
 *      cd $TMPDIR/base/backend-ts && bun run <this file> --surface director.v1 --out v1.json
 *    director.v2 — frozen since director.v3 (written by this script on the v25 merge's tree, b73f0ed)
 *    director.v3 — frozen since director.v4 (written by this script on 73c55f3's tree)
 *    director.v4 — frozen since director.v5 (written by this script on fd0b47e's tree)
 *    director.v5 — frozen since director.v6 (written by this script on ba2e5e5's tree)
 *    director.v6 — frozen since director.v7 (written by this script on 5aa828f's tree)
 *    director.v7 — frozen since director.v8 (written by this script on 55b8bd7's tree)
 *    director.v8 — frozen since director.v9 (written by this script on c738506's tree)
 *    director.v9 — frozen since director.v10 (written by this script on 7c487d8's tree)
 *    director.v10 — frozen since director.v11 (written by this script on 261ddcd's tree)
 *    director.v11 — run in this tree: bun run scripts/director_surface_snapshot.ts --surface director.v11 --out src/director/surfaces/director.v11.json
 *
 *  It lists tools only: no tool is called, no server listens, nothing reaches the network. */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

type Rec = Record<string, unknown>
const sha = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

/** The texts a director conversation holds that the harness wrote (not the person, not the model). */
export const TEMPLATE_KEYS = [
  'director.context', 'director.task_event', 'director.person_runs', 'director.plan', 'director.plan_title', 'director.plan_in_place',
  'director.plan_images', 'director.decide', 'director.decide_step', 'director.plan_none', 'director.interaction_question',
  'director.native_wait_refusal', 'director.session_refusal',
] as const

/** A fixed event pair, rendered by the tree's own outbox: a later surface change that alters a v1 conversation's
 *  task-event message is caught against this rendering. */
export const GOLDEN_EVENTS = [
  { id: 'ev_golden1', director_session_id: 'ds_golden', session_id: 's_golden', kind: 'run_finished', ref_id: 'run_0a1b2c3d4e5f', cause_turn_id: 'turn_golden1', dedupe_key: 'run_finished:run_0a1b2c3d4e5f',
    status: 'pending', attempts: 0, error: null, delivered_turn_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    payload: { run_id: 'run_0a1b2c3d4e5f', label: 'fix', model: 'm:a', spawned_by: 'human', is_thread_run: true, status: 'done', error: null, lock_violations: 0, failed_executions: 1,
      checks: { passed: 2, failed: 0, unknown: 0, not_run: 1 }, files_changed: 1, lines_added: 3, lines_removed: 1, checkpoints: [], final_checkpoint_id: 'cp_1', refused_calls: 0, tool_calls: 4,
      user_text_head: 'make add() add', final_text_head: 'patched', workspace_id: 'ws_1', finished_at: '2026-01-01T00:00:01.000Z' } },
  { id: 'ev_golden2', director_session_id: 'ds_golden', session_id: 's_golden', kind: 'interaction_finished', ref_id: 'ix_golden', cause_turn_id: 'turn_golden1', dedupe_key: 'interaction_finished:ix_golden:1:2:done',
    status: 'pending', attempts: 0, error: null, delivered_turn_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    payload: { interaction_id: 'ix_golden', status: 'done', nodes: [{ id: 'a1', run_id: 'run_0a1b2c3d4e60', answer_ref: { run_id: 'run_0a1b2c3d4e60', endpoint: '/api/runs/run_0a1b2c3d4e60', field: 'receipt.final_text' } }] } },
]

async function listed(server: { connect(t: unknown): Promise<void>; close(): Promise<void> }): Promise<{ tools: Rec[]; instructions: string }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const client = new McpClient({ name: 'surface snapshot', version: '1' })
  await client.connect(clientSide)
  const { tools } = await client.listTools()
  const instructions = client.getInstructions() ?? ''
  await client.close()
  await server.close()
  return { tools: tools as Rec[], instructions }
}

async function main(argv: string[]): Promise<void> {
  const at = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }
  const surface = at('--surface') ?? 'director.v1'
  const out = at('--out')
  const root = process.cwd()
  const { Harness } = await import(join(root, 'src/director/harness.ts'))
  const { PROMPT_TEXT } = await import(join(root, 'src/prompt_texts.ts'))
  const { cleanSchema } = await import(join(root, 'src/llm/http.ts'))
  const server = await import(join(root, 'src/director/server.ts'))
  const outbox = await import(join(root, 'src/director/outbox.ts'))
  const harness = Harness.connect('http://127.0.0.1:9', 'unused')
  let connector: { tools: Rec[]; instructions: string }
  let nativeListed: Rec[]
  let nativeInstructions: string
  let templates: Rec
  let golden: Rec
  if (surface === 'director.v1') {
    // the baseline's own construction: the connector server, and the native subset directorToolset() derives from it
    const { NATIVE_EXCLUDED_TOOLS } = await import(join(root, 'src/director/tools.ts'))
    const { NATIVE_INSTRUCTIONS } = await import(join(root, 'src/director/manual.ts'))
    connector = await listed(server.buildServer(harness))
    nativeListed = connector.tools.filter((t) => !NATIVE_EXCLUDED_TOOLS.has(String(t.name)))
    nativeInstructions = NATIVE_INSTRUCTIONS
    const nativeSource = readFileSync(join(root, 'src/director/transports/native.ts'), 'utf8')
    const prefix = /`(Original message envelope \(attachment IDs are forwarded unchanged to agents\): )\$\{/.exec(nativeSource)?.[1]
    if (!prefix) throw new Error('the envelope line was not found in transports/native.ts')
    templates = { ...Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, PROMPT_TEXT[k]])), 'native.envelope_prefix': prefix }
    golden = { task_event_message: outbox.taskEventMessage('s_golden', GOLDEN_EVENTS), person_runs_message: outbox.personRunsMessage(GOLDEN_EVENTS.slice(0, 1)) }
  } else if (surface === 'director.v11') {
    const surfaces = await import(join(root, 'src/director/surfaces/index.ts'))
    connector = await listed(server.buildServer(harness, { surface, audience: 'connector', frozen: false }))
    nativeListed = (await listed(server.buildServer(harness, { surface, audience: 'native', frozen: false }))).tools
    nativeInstructions = surfaces.composeNativeInstructions(surface)
    templates = surfaces.composeTemplates(surface)
    // the golden rendering reads the committed templates: a first run on a new surface writes them, the second renders
    try {
      golden = { task_event_message: outbox.taskEventMessage('s_golden', GOLDEN_EVENTS, surface), person_runs_message: outbox.personRunsMessage(GOLDEN_EVENTS.slice(0, 1), surface) }
    } catch (error) {
      process.stderr.write(`golden not rendered yet (${(error as Error).message}): run the script again\n`)
      golden = {}
    }
  } else throw new Error(`unknown surface ${surface}`)
  const nativeTools = nativeListed.map((t) => ({ name: t.name, description: t.description ?? t.name, parameters_json_schema: cleanSchema((t.inputSchema ?? { type: 'object', properties: {} }) as Rec) }))
  const snapshot = {
    surface,
    note: surface === 'director.v1' ? 'generated from main 3d06c7b0cb2ede86f3c4e5423037fa05536a478f (schema v24) by scripts/director_surface_snapshot.ts; read as data at runtime, never regenerated from code' : 'generated by scripts/director_surface_snapshot.ts; read as data at runtime — a change here is a new surface, never an edit of this one',
    connector: { instructions: connector.instructions, tools: connector.tools },
    native: { instructions: nativeInstructions, tools: nativeTools },
    templates, golden,
    sha256: {
      connector_tools: sha(connector.tools), connector_instructions: sha(connector.instructions),
      native_tools: sha(nativeTools), native_instructions: sha(nativeInstructions), templates: sha(templates), golden: sha(golden),
    },
  }
  const textOut = `${JSON.stringify(snapshot, null, 2)}\n`
  if (out) writeFileSync(out, textOut)
  else process.stdout.write(textOut)
  process.stderr.write(`${surface}: connector ${connector.tools.length} tools, native ${nativeTools.length} tools\n${JSON.stringify(snapshot.sha256, null, 2)}\n`)
}

if (import.meta.main) await main(process.argv.slice(2))
