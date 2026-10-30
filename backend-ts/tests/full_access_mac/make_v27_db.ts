/** Run against a BASELINE tree (schema v27) only: writes a v27 database with one direct project and two sessions (one
 *  in Auto, one in Plan) for the candidate's migration test (qa_full_access.mac.ts, QA_V27_DATA).
 *    usage: bun run tests/full_access_mac/make_v27_db.ts <baseline-tree-root> <out-data-dir> <project-folder>
 *  (run from the baseline tree's backend-ts, its dependencies installed). Prints the ids as JSON. No network, no data
 *  directory of the person's (out-data-dir is the data dir). */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const [rootArg, out, folder] = process.argv.slice(2)
if (!rootArg || !out || !folder) throw new Error('usage: make_v27_db.ts <baseline-tree-root> <out-data-dir> <project-folder>')
const root = resolve(rootArg)
const { Settings } = await import(join(root, 'backend-ts/src/config.ts'))
const { connect } = await import(join(root, 'backend-ts/src/db/database.ts'))
const repo = await import(join(root, 'backend-ts/src/db/repo.ts'))
const { SCHEMA_VERSION } = await import(join(root, 'contract/src/version.ts'))
const { WorkspaceService } = await import(join(root, 'backend-ts/src/workspace/service.ts'))
const { applySessionMode } = await import(join(root, 'backend-ts/src/policy/modes.ts'))
const { effectiveControl } = await import(join(root, 'backend-ts/src/policy/gate.ts'))
const { inferMode } = await import(join(root, 'contract/src/modes.ts'))
if (SCHEMA_VERSION !== 27) throw new Error(`not a v27 tree (SCHEMA_VERSION=${SCHEMA_VERSION})`)
const settings = new Settings({ data_dir: out, host: '127.0.0.1', port: 0, session_token: 'qa-v27-token' })
mkdirSync(settings.data_dir, { recursive: true })
const conn = connect(settings.db_path)
const ws = new WorkspaceService(settings, conn)
const project = await ws.importProject('v27-direct', folder, { mode: 'direct' })
const a = repo.createSession(conn, project.id, 'old auto session', 'scripted:a')
const b = repo.createSession(conn, project.id, 'old plan session', 'scripted:a')
const wa = await ws.createWorkspace(project, a.id)
repo.setSessionWorkspace(conn, a.id, wa.id)
repo.setSessionWorkspace(conn, b.id, wa.id)
// the baseline's own mode presets, as its API applies them: a in Auto, b in Plan (fixture data only)
conn.transaction(() => { applySessionMode(conn, repo.getSession(conn, a.id)!, 'auto'); applySessionMode(conn, repo.getSession(conn, b.id)!, 'plan') })
const recorded = Object.fromEntries([a.id, b.id].map((id) => {
  const s = repo.getSession(conn, id)!
  const control = effectiveControl(conn, id)
  return [id, { grants: s.grants, control: { desired_state: control.desired_state, gate_effects: control.gate_effects }, mode: inferMode(s.grants, control) }]
}))
if (recorded[a.id].mode !== 'auto' || recorded[b.id].mode !== 'plan') throw new Error(`fixture modes not set: ${JSON.stringify(recorded)}`)
writeFileSync(join(out, 'v27-fixture.json'), JSON.stringify({ auto: a.id, plan: b.id, sessions: recorded }, null, 1))
const version = conn.get('PRAGMA user_version') as Record<string, number>
console.log(JSON.stringify({ db: settings.db_path, project: project.id, sessions: [a.id, b.id], workspace: wa.id, user_version: version, schema: SCHEMA_VERSION, modes: { [a.id]: 'auto', [b.id]: 'plan' } }))
conn.close(); ws.close()
