import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { ModelRequestRecordSchema, ReceiptSchema, SCHEMA_VERSION, type ModelRequestRecord } from '@oasis-code/contract'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { ModelConfig, STANDARD_CN_MODELS } from '../src/config.ts'
import { UsageMeter } from '../src/llm/usage.ts'
import { modelRequest, modelResponse, userPrompt, textPart } from '../src/llm/messages.ts'
import { ScriptedModel } from '../src/llm/scripted.ts'
import { contextReport } from '../src/agent/context_report.ts'
import { runRoutes } from '../src/api/runs.ts'
import { appState, buggyRepo, closeState, openSession, testConfig, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'

const glm = new ModelConfig(STANDARD_CN_MODELS.find((m) => m.model === 'glm-5.3') as never)
const params = { function_tools: [], allow_text_output: true, thinking: null }
const counted = () => new ScriptedModel(() => modelResponse([textPart('done')]), { usage: { input_tokens: 1000, cache_read_tokens: 250, output_tokens: 100 } })

test('CNY per-request records, events and totals accumulate independently, including a resumed meter', async () => {
  const records: ModelRequestRecord[] = [], events: Record<string, unknown>[] = []
  const meter = new UsageMeter(counted(), glm, 'r', (r) => records.push(r), (_e, data) => events.push(data))
  await meter.request([modelRequest([userPrompt('hi')])], {}, params)
  await meter.request([modelRequest([userPrompt('hi again')])], {}, params)
  expect(records.map((r) => [r.cost_usd, r.cost_cny, r.cost_status])).toEqual([[null, .0093, 'estimated'], [null, .0093, 'estimated']])
  expect(events.every((e) => e.cost_cny === .0093 && e.cost_usd === null)).toBe(true)
  expect(meter.totalsWithTokens()).toMatchObject({ cost_usd: null, cost_cny: .0186, cost_status: 'estimated' })
  const resumed = new UsageMeter(counted(), glm, 'r', () => {}, () => {}, meter.totalsWithTokens())
  await resumed.request([], {}, params)
  expect(resumed.totals.cost_cny).toBeCloseTo(.0279, 9)
  expect(resumed.totals.cost_usd).toBeNull()
  expect(resumed.totals.cost_status).toBe('estimated')
  const failed = new UsageMeter(new ScriptedModel(() => { throw new Error('offline failure') }), glm, 'r', () => {}, () => {}, resumed.totalsWithTokens())
  await expect(failed.request([], {}, params)).rejects.toThrow('offline failure')
  expect(failed.totals.cost_cny).toBeCloseTo(.0279, 9)
  expect(failed.totals.cost_status).toBe('partial')
})

test('v31 to v32 preserves old USD rows as unknown CNY and roundtrips new CNY records', () => {
  const path = join(tempDir(), 'index.db')
  const old = connect(path)
  old.exec('ALTER TABLE model_requests DROP COLUMN cost_cny; DROP INDEX IF EXISTS runs_read; PRAGMA user_version=31;')
  old.run("INSERT INTO projects (id,name,base_repo_path,created_at,updated_at) VALUES ('p','p','/fixture','t','t')")
  old.run("INSERT INTO sessions (id,project_id,title,model,created_at,updated_at) VALUES ('s','p','s','m','t','t')")
  old.run("INSERT INTO runs (id,session_id,project_id,model,user_text,status,created_at) VALUES ('r','s','p','m','hi','done','t')")
  old.run("INSERT INTO model_requests (id,run_id,seq,model_id,configured_model,endpoint,started_at,cost_usd,cost_status) VALUES ('old','r',1,'m','m','https://fixture.invalid','t',0.5,'estimated')")
  old.close()
  const db = connect(path)
  try {
    expect(db.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
    expect(repo.listModelRequests(db, 'r')[0]).toMatchObject({ cost_usd: .5, cost_cny: null })
    const record = ModelRequestRecordSchema.parse({ id: 'new', run_id: 'r', seq: 2, model_id: glm.id, configured_model: glm.model,
      provider_reported_model: glm.model, endpoint: glm.endpoint, started_at: 't', latency_ms: 1, cost_cny: .0093, cost_usd: null, cost_status: 'estimated' })
    repo.insertModelRequest(db, record)
    expect(repo.listModelRequests(db, 'r')[1]).toEqual(record)
  } finally { db.close() }
  const again = connect(path)
  try { expect(repo.listModelRequests(again, 'r')[1]!.cost_cny).toBe(.0093) } finally { again.close() }
})

test('CNY run cost reaches persisted receipt, request API, receipt API and event payload', async () => {
  const state = await appState({ config: testConfig([glm]), models: { [glm.id]: counted() } })
  try {
    const { session } = await openSession(state, buggyRepo(), glm.id)
    const run = await waitDone(state, (await state.runs.start(session, 'hello')).id)
    expect(run.status).toBe('done')
    expect(run.usage).toMatchObject({ cost_usd: null, cost_cny: .0093, cost_status: 'estimated' })
    expect(ReceiptSchema.parse(run.receipt).mechanical).toMatchObject({ cost_usd: null, cost_cny: .0093, cost_status: 'estimated' })
    expect(repo.listModelRequests(state.conn, run.id)[0]).toMatchObject({ cost_usd: null, cost_cny: .0093 })
    expect(repo.listEvents(state.conn, run.id).find((e) => e.event === 'model_request')!.data).toMatchObject({ cost_cny: .0093, cost_usd: null })
    const api = runRoutes({ state } as never)
    const data = await (await api.request(`/api/runs/${run.id}`)).json() as Record<string, any>
    expect(data.requests[0]).toMatchObject({ cost_usd: null, cost_cny: .0093 })
    expect(data.usage.cost_cny).toBe(.0093)
    expect(contextReport(state, session.id).last_run).toMatchObject({ cost_usd: null, cost_cny: .0093 })
    const receipt = await (await api.request(`/api/runs/${run.id}/receipt`)).json() as Record<string, any>
    expect(receipt.receipt.mechanical.cost_cny).toBe(.0093)
  } finally { await closeState(state) }
})
