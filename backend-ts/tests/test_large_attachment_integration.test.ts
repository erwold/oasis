/** The integration of the exact input files (docs/large-file-attachments-security.md §3): the session's sent uploads
 *  reach a command's box as `exact_reads` through all three command paths — the agent's bash, an approved proposal,
 *  the API/director command — carried through ProcessManager.start, never an unsent upload, another session's, or a
 *  local file; a refusal (here: a seal lifted) leaves the file out, says so in the command's result and as a run event,
 *  and changes no tool. The box is captured at the runtime (passthrough: the mechanics, not the kernel) and rendered by
 *  the real Seatbelt profile writer, so a box it would refuse fails here too. Offline, scripted model. */

import { afterEach, expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { UPLOAD_CHUNK_BYTES, type FileRefAttachment, type Session } from '@oasis-code/contract'
import { ModelConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { SeatbeltRuntime, type IsolationReport, type IsolationRuntime, type Sandbox } from '../src/execution/isolation.ts'
import { lastToolReturn, modelResponse, textPart, toolCallPart } from '../src/llm/messages.ts'
import { createApp, type App } from '../src/main.ts'
import * as gate from '../src/policy/gate.ts'
import { unsealStoredFile } from '../src/workspace/attachment_access.ts'
import { Client, json } from './api_harness.ts'
import { buggyRepo, FAKE_FULL, scriptedModel, setModel, testConfig, testSettings, waitDone } from './harness.ts'
import { tempDir } from './helpers.ts'
import { pdfFixture } from './file_fixtures.ts'
import { lstatSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { PROVIDER_REQUEST_LIMITS } from '@oasis-code/contract'
import { attachmentPiece, attachmentReader, hydrateAttachments, memoizedReader } from '../src/llm/attachments.ts'
import { modelRequest, userPrompt } from '../src/llm/messages.ts'
import { refAccess } from '../src/llm/ref_files.ts'
import { isSealed } from '../src/workspace/attachment_access.ts'
import { legacyFileAttachment } from './file_fixtures.ts'

let app: App | null = null
afterEach(async () => { await app?.close(); app = null })

/** Runs the command as it is and keeps every box it was handed (rendered once by the real profile writer). */
class CapturingRuntime implements IsolationRuntime {
  readonly name = 'passthrough'
  readonly boxes: Sandbox[] = []
  readonly profiles: string[] = []
  constructor(private readonly dataDir: string) {}
  fingerprint(): string { return 'passthrough' }
  command(argv: string[], box: Sandbox, _profile: string): string[] {
    this.boxes.push(box)
    if (process.platform === 'darwin') this.profiles.push(new SeatbeltRuntime({ extra_read_deny: [this.dataDir] }).profile(box))
    return argv
  }
  async probe(): Promise<IsolationReport> { return { ...FAKE_FULL, runtime: this.name } }
}

async function uploadPdf(c: Client, session: Session, words: string): Promise<FileRefAttachment> {
  const bytes = pdfFixture(words)
  const up = await json<{ upload_id: string; chunk_bytes: number }>(await c.post(`/api/sessions/${session.id}/uploads`, { name: `${words}.pdf`, size: bytes.length, type: 'application/pdf' }))
  expect(up.chunk_bytes).toBe(UPLOAD_CHUNK_BYTES)
  const put = await c.app.app.request(`http://localhost/api/sessions/${session.id}/uploads/${up.upload_id}?offset=0`, { method: 'PUT', body: bytes, headers: { ...c.headers, 'content-type': 'application/octet-stream' } })
  expect(put.status).toBe(200)
  return json<FileRefAttachment>(await c.post(`/api/sessions/${session.id}/uploads/${up.upload_id}/complete`, {}))
}

test('the session\'s sent uploads reach every command path as exact reads; nothing else does; a refusal is said, the tools unchanged', async () => {
  const settings = testSettings()
  const runtime = new CapturingRuntime(settings.data_dir)
  const config = testConfig()
  config.models = [new ModelConfig({ id: 'scripted:a', provider: 'openai', model: 'scripted-a', capabilities: { images: false } })]
  config.default_model = 'scripted:a'
  app = await createApp(settings, config, { runtime, isolation: { ...FAKE_FULL, runtime: 'passthrough' } })
  const state = app.state
  const c = new Client(app)
  const project = await json<{ id: string }>(await c.post('/api/projects', { source_path: buggyRepo() }))
  // sandbox sessions: the exact reads are rules of the sandbox's box (a Full access command runs on the host, no box)
  const session = await json<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'grants', access_mode: 'sandbox' }))
  const sibling = await json<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'sibling', access_mode: 'sandbox' }))
  const sent = await uploadPdf(c, session, 'sent')
  const unsent = await uploadPdf(c, session, 'unsent')
  const theirs = await uploadPdf(c, sibling, 'theirs')
  const localPath = join(tempDir('oasis-grant-local-'), 'mine.pdf'); writeFileSync(localPath, pdfFixture('local'))
  const local = await json<FileRefAttachment>(await c.post(`/api/sessions/${session.id}/attachments/local`, { path: localPath }))
  // the sibling session sends its own upload: still never this session's
  setModel(state, 'scripted:a', scriptedModel(() => modelResponse([textPart('seen')])))
  expect((await waitDone(state, (await json<{ id: string }>(await c.post(`/api/sessions/${sibling.id}/chat`, { text: 'theirs', attachments: [theirs.asset_id] }))).id)).status).toBe('done')

  // 1. the agent's bash
  const results: unknown[] = []
  setModel(state, 'scripted:a', scriptedModel((m) => {
    const back = lastToolReturn(m, 'bash')
    if (!back) return modelResponse([toolCallPart('bash', { command: 'echo granted', wait_s: 30 }, '')])
    results.push(back)
    return modelResponse([textPart('ran')])
  }))
  const first = await json<{ id: string }>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'look', attachments: [sent.asset_id, local.asset_id] }))
  expect((await waitDone(state, first.id)).status).toBe('done')
  const expected = { files: [realpathSync.native(sent.location)], within: [realpathSync.native(state.store.root)], data_root: realpathSync.native(settings.data_dir) }
  const commandBoxes = () => runtime.boxes.filter((b) => b.writable.length > 1)
  if (process.platform !== 'darwin') {
    // no seal here: no upload is granted; the refusal is said (attachment_access_refused), the command still runs
    expect(commandBoxes().at(-1)!.exact_reads ?? null).toBeNull()
    expect(JSON.stringify(results.at(-1))).toContain('no seal against a writable hard-link alias on this platform')
    return
  }
  expect(commandBoxes().at(-1)!.exact_reads).toEqual(expected)
  expect(runtime.profiles.at(-1)).toContain(`(literal "${expected.files[0]}")`)
  for (const other of [unsent.location, theirs.location, local.location]) expect(JSON.stringify(commandBoxes().at(-1)!.exact_reads)).not.toContain(other)
  expect(JSON.stringify(results.at(-1))).not.toContain('attachment_access_refused')

  // 2. the API / director command path
  const wsId = session.workspace_id!
  const api = await c.post(`/api/workspaces/${wsId}/commands`, { command: 'echo api', wait_s: 30 })
  expect(api.status).toBe(200)
  expect(commandBoxes().at(-1)!.exact_reads).toEqual(expected)

  // 3. an approved proposal
  gate.recordRunControl(state.conn, session.id, 'pause', ['isolated_code_execution'])
  setModel(state, 'scripted:a', scriptedModel((m) => (!lastToolReturn(m, 'bash')
    ? modelResponse([toolCallPart('bash', { command: 'echo approved', wait_s: 30 }, '')]) : modelResponse([textPart('proposed')]))))
  const proposing = await json<{ id: string }>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'propose', fresh: true }))
  await waitDone(state, proposing.id)
  const proposal = gate.listProposals(state.conn, session.project_id, session.id).find((p) => p.status === 'pending')!
  const before = commandBoxes().length
  const decided = await gate.decideProposal(state, proposal.proposal_asset_id, 'approve')
  expect(decided.status).toBe('approved')
  expect(commandBoxes().length).toBe(before + 1)
  expect(commandBoxes().at(-1)!.exact_reads).toEqual(expected)
  gate.recordRunControl(state.conn, session.id, 'run')

  // a refusal: the seal lifted behind the harness's back — the file is not granted, the result and an event say so
  unsealStoredFile(realpathSync.native(sent.location), { data_dir: settings.data_dir, store_root: state.store.root })
  results.length = 0
  setModel(state, 'scripted:a', scriptedModel((m) => {
    const back = lastToolReturn(m, 'bash')
    if (!back) return modelResponse([toolCallPart('bash', { command: 'echo refused', wait_s: 30 }, '')])
    results.push(back)
    return modelResponse([textPart('ran')])
  }))
  const refusedRun = await json<{ id: string }>(await c.post(`/api/sessions/${session.id}/chat`, { text: 'again', fresh: true }))
  expect((await waitDone(state, refusedRun.id)).status).toBe('done')
  expect(commandBoxes().at(-1)!.exact_reads ?? null).toBeNull()
  expect(JSON.stringify(results.at(-1))).toContain('attachment_access_refused')
  // lifting the seal moved its ctime: the recorded identity no longer matches (checked before the seal itself)
  expect(JSON.stringify(results.at(-1))).toContain('not the file that was stored')
  const events = repo.listEvents(state.conn, refusedRun.id).filter((e) => e.event === 'attachment_refused')
  expect(events.map((e) => [e.data.scope, e.data.asset_id])).toEqual([['command', sent.asset_id]])
  const apiRefused = await json<Record<string, unknown>>(await c.post(`/api/workspaces/${wsId}/commands`, { command: 'echo api', wait_s: 30 }))
  expect(JSON.stringify(apiRefused.attachment_access_refused)).toContain(sent.asset_id)

  // the tools never changed across these runs
  const tools = (id: string) => (repo.getRun(state.conn, id)!.manifest as { tools?: string[] }).tools
  expect(tools(refusedRun.id)).toEqual(tools(first.id))
  const schemas = new Set([first.id, refusedRun.id].flatMap((id) => repo.listModelRequests(state.conn, id).map((r) => r.tool_schema_sha256)))
  expect(schemas.size).toBe(1)
})

async function plainApp() {
  const config = testConfig()
  config.models = [new ModelConfig({ id: 'scripted:a', provider: 'anthropic', model: 'scripted-a', capabilities: { images: true, pdf: true } })]
  config.default_model = 'scripted:a'
  app = await createApp(testSettings(), config, { probe: false })
  const c = new Client(app)
  const project = await json<{ id: string }>(await c.post('/api/projects', { source_path: buggyRepo() }))
  const session = await json<Session>(await c.post(`/api/projects/${project.id}/sessions`, { title: 'cache' }))
  return { c, session, state: app.state }
}

test('an upload is sealed at its final name, its identity recorded; the same bytes again keep the same sealed file and identity', async () => {
  const { c, session, state } = await plainApp()
  const a = await uploadPdf(c, session, 'twice')
  const b = await uploadPdf(c, session, 'twice')
  expect(b.location).toBe(a.location)
  expect(b.asset_id).not.toBe(a.asset_id)
  const fa = repo.getAsset(state.conn, a.asset_id)!.meta.fingerprint, fb = repo.getAsset(state.conn, b.asset_id)!.meta.fingerprint
  expect(lstatSync(a.location).nlink).toBe(1)
  if (process.platform === 'darwin') {
    expect(isSealed(a.location)).toBe(true)
    const st = statSync(a.location, { bigint: true })
    expect(fa).toEqual({ dev: String(st.dev), ino: String(st.ino), size: String(st.size), mtime_ns: String(st.mtimeNs), ctime_ns: String(st.ctimeNs) })
    expect(fb).toEqual(fa)                                                     // the second upload did not touch the first's seal
  } else {
    // no seal on this platform: nothing recorded, the upload still works for the model and the download
    expect(fa).toBeUndefined()
    expect(isSealed(a.location)).toBe(false)
  }
  expect((await c.get(`/api/sessions/${session.id}/attachments/${a.asset_id}`)).status).toBe(200)
})

test('a cached legacy read is keyed by every frozen field and its record checked on every hit (name, type, session)', async () => {
  const { session, state } = await plainApp()
  const text = await legacyFileAttachment(state, session, Buffer.from('hello cache\n'), 'notes.txt')
  let reads = 0
  const base = attachmentReader((id) => repo.getAsset(state.conn, id), (p) => { reads += 1; return state.store.read(p) }, session.project_id, session.id)
  const memo = memoizedReader(base)
  expect(memo(text)).not.toBeNull()
  expect(memo(text)).not.toBeNull()
  expect(reads).toBe(1)                                                        // the hit read nothing
  // the same id and hash under another name or type: another key, refused by its record
  expect(memo({ ...text, name: 'other.txt' } as never)).toBeNull()
  expect(memo({ ...text, media_type: 'text/x-other' } as never)).toBeNull()
  // the row moved to another session: the cached bytes are not answered any more
  const asset = repo.getAsset(state.conn, text.asset_id)!
  state.conn.run('UPDATE assets SET meta_json = ? WHERE id = ?', [JSON.stringify({ ...asset.meta, session_id: 's_elsewhere' }), text.asset_id])
  expect(memo(text)).toBeNull()
  expect(() => hydrateAttachments([modelRequest([userPrompt(['x', attachmentPiece(text)])])], memo, { images: true }, 'a')).toThrow('outside this session')
})

test('a cached native local file is checked on every request through the security helper: its folder swapped is refused, never followed', async () => {
  const { c, session, state } = await plainApp()
  const dir = join(tempDir('oasis-native-swap-'), 'docs')
  mkdirSync(dir)
  const path = join(dir, 'paper.pdf'); writeFileSync(path, pdfFixture('the original'))
  const ref = await json<FileRefAttachment>(await c.post(`/api/sessions/${session.id}/attachments/local`, { path }))
  const refs = refAccess({ lookup: (id) => repo.getAsset(state.conn, id), store: state.store, project: session.project_id, session: session.id, local: state.runs.localAccess(session.project_id) })
  const read = attachmentReader((id) => repo.getAsset(state.conn, id), (p) => state.store.read(p), session.project_id, session.id)
  const history = [modelRequest([userPrompt(['look', attachmentPiece(ref)])])]
  const route = { limits: PROVIDER_REQUEST_LIMITS.anthropic, refs }
  expect(JSON.stringify(hydrateAttachments(history, read, { pdf: true }, 'a', null, route))).toContain(pdfFixture('the original').toString('base64'))
  expect(refs.reads).toBe(1)
  // the folder renamed away and another put at its name with a file of the same name: the cached bytes are not sent,
  // the other file is not read
  renameSync(dir, `${dir}.old`)
  mkdirSync(dir)
  writeFileSync(path, pdfFixture('the original'))
  expect(() => hydrateAttachments(history, read, { pdf: true }, 'a', null, route)).toThrow('changed or was replaced since it was attached')
  expect(refs.reads).toBe(1)
  // the folder a link to the old one (the same file, reached through a link): the very same inode — still the file
  rmSync(dir, { recursive: true })
  symlinkSync(`${dir}.old`, dir)
  expect(JSON.stringify(hydrateAttachments(history, read, { pdf: true }, 'a', null, route))).toContain(pdfFixture('the original').toString('base64'))
  // ...but a path-only route never touches it at all, gone or not
  rmSync(dir)
  rmSync(`${dir}.old`, { recursive: true })
  expect(JSON.stringify(hydrateAttachments(history, read, { images: false }, 'b', null, { limits: PROVIDER_REQUEST_LIMITS.openai_api, refs }))).toContain('its content is not in this message')
})
