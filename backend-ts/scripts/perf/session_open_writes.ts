/** Synthetic write/invalidated-read comparison. Run the SAME script against each source tree serially, in a
 * fresh private directory; never point BENCH_WRITE_ROOT at app data. No app, listener, model or external action. */
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = resolve(process.env.BENCH_WRITE_ROOT || (() => { throw Error('BENCH_WRITE_ROOT required') })())
const tree = resolve(process.env.BENCH_TREE || (() => { throw Error('BENCH_TREE required') })())
const path = join(root, 'synthetic-index.db')
if (existsSync(path)) throw Error('refuse to overwrite any database')
mkdirSync(root, { recursive: true })
const load = (p: string) => import(pathToFileURL(join(tree, 'backend-ts/src', p)).href)
const { connect } = await load('db/database.ts'), repo = await load('db/repo.ts')
const { rebuildStoredTranscript } = await load('agent/transcript.ts')
const { modelRequest, modelResponse, userPrompt, textPart, dumpJson } = await load('llm/messages.ts')
const conn = connect(path)
conn.run('PRAGMA wal_autocheckpoint=0')
const p = repo.createProject(conn, 'synthetic', { source_path: null, base_repo_path: '/synthetic', base_branch: null, base_commit: null, import_report: {} })
const s = repo.createSession(conn, p.id, 'synthetic', 'scripted:a'), other = repo.createSession(conn, p.id, 'neighbor', 'scripted:a')
const insert = (parent: string | null) => repo.insertRun(conn, { session_id: s.id, project_id: p.id, workspace_id: null, model: 'scripted:a', model_config: {}, user_text: 'q', status: 'done', budget: {}, resumes_run_id: parent })
const finish = (id: string, raw: string) => repo.finishRun(conn, id, 'done', { history_json: raw, usage: {}, receipt: {}, error: null, saved_seq: 1 })
let messages: unknown[] = [], parent: string | null = null
for (let i = 0; i < 12; i++) {
  const r = insert(parent)
  messages.push(modelRequest([userPrompt(`synthetic ${i}`)]), modelResponse([textPart('synthetic '.repeat(24000))]))
  finish(r.id, dumpJson(messages)); parent = r.id
}
const current = insert(parent)
messages.push(modelRequest([userPrompt('current')]), modelResponse([textPart('complete own answer')]))
const base = dumpJson(messages)
finish(current.id, base)
const checkpoint = () => conn.all('PRAGMA wal_checkpoint(TRUNCATE)')
const wal = () => existsSync(path + '-wal') ? statSync(path + '-wal').size : 0
function measured(name: string, n: number, operation: (i: number) => void) {
  checkpoint()
  const samples: number[] = []
  for (let i = 0; i < n; i++) { const t = performance.now(); operation(i); samples.push(performance.now() - t) }
  return { name, n, samples_ms: samples, wal_bytes: wal() }
}
const results = [
  measured('saveRunProgress_history', 30, i => repo.saveRunProgress(conn, current.id, base.slice(0, -1) + ',' + JSON.stringify(modelResponse([textPart(`increment ${i}`)])) + ']', { requests: i }, i)),
  measured('saveRunProgress_usage_only', 30, i => repo.saveRunProgress(conn, current.id, null, { requests: i }, i)),
  measured('finishRun_with_projection', 10, i => finish(current.id, base.slice(0, -1) + ',' + JSON.stringify(modelResponse([textPart(`finished ${i}`)])) + ']')),
]
const get = conn.get.bind(conn)
let rawReads = 0, rawBytes = 0
conn.get = (sql: string, args: unknown[]) => { const value = get(sql, args); if (sql === 'SELECT history_json FROM runs WHERE id=?') { rawReads++; rawBytes += Buffer.byteLength(value?.history_json ?? '') } return value }
results.push(measured('read_after_neighbor_write', 30, i => { repo.renameSession(conn, other.id, `neighbor ${i}`); rebuildStoredTranscript(conn, repo.getTranscriptRun(conn, current.id), 'done') }))
const result = { source: tree, schema: conn.get('PRAGMA user_version').user_version, source_history_bytes: Buffer.byteLength(base), results, invalidated_read_raw_reads: rawReads, invalidated_read_raw_bytes: rawBytes }
writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2))
conn.close()
console.log(JSON.stringify(result))
