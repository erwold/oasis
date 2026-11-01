import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, SCHEMA_VERSION } from '../src/db/database.ts'
import { RemoteWorkspaceService, type RemoteHostProvider } from '../src/workspace/remote.ts'
import * as repo from '../src/db/repo.ts'
import { tempDir } from './helpers.ts'

function structure(conn: ReturnType<typeof connect>) {
  return conn.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({ name }) => ({
    name, columns: conn.all(`PRAGMA table_info(${name})`).map(r => [r.name, r.type, r.notnull, r.dflt_value, r.pk]),
    indexes: conn.all(`PRAGMA index_list(${name})`).map(r => r.name).sort(),
  }))
}

test('v29 upgrades to the current schema without changing old project/session history and equals fresh; reopen is idempotent', () => {
  const dir = tempDir('remote-v29-')
  const path = join(dir, 'old.db')
  const raw = new Database(path)
  raw.exec(readFileSync(join(import.meta.dir, 'fixtures/schema_v29.sql'), 'utf8'))
  raw.exec("DROP INDEX IF EXISTS runs_read; PRAGMA user_version=29; INSERT INTO projects (id,name,source_path,base_repo_path,kind,created_at,updated_at) VALUES ('p_old','old','/same/path','','direct','t','t'); INSERT INTO sessions (id,project_id,title,model,access_mode,created_at,updated_at) VALUES ('s_old','p_old','keep','m','full','t','t');")
  const oldSession = raw.query<Record<string, string | number | null>, []>('SELECT * FROM sessions').get()
  raw.close()
  const upgraded = connect(path)
  const fresh = connect(join(dir, 'fresh.db'))
  try {
    expect(upgraded.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION)
    expect(upgraded.get('SELECT * FROM sessions')).toEqual({ ...oldSession, pin_order: null })
    expect(repo.getProject(upgraded, 'p_old')!.target).toEqual({ kind: 'local' })
    expect(structure(upgraded)).toEqual(structure(fresh))
    expect(upgraded.all('SELECT * FROM ssh_targets')).toEqual([])
  } finally { upgraded.close(); fresh.close() }
  const again = connect(path)
  try { expect(again.get('PRAGMA user_version')!.user_version).toBe(SCHEMA_VERSION) } finally { again.close() }
})

/** A v30 database as v30 left it (its own schema file, tests/fixtures/schema_v30.sql = schema.sql at c738506): one
 *  target for each state v30 could write. v30 wrote 'disconnected' for a Disconnect and for every graceful shutdown
 *  alike and recorded nothing else of which it was, so only states a Connect leaves become 'connect'. */
test('v30 upgrades to v31: connect intent seeded only from states a Connect leaves; an ambiguous disconnected target with a running job stays paused', async () => {
  const dir = tempDir('remote-v30-')
  const path = join(dir, 'v30.db')
  const raw = new Database(path)
  raw.exec(readFileSync(join(import.meta.dir, 'fixtures/schema_v30.sql'), 'utf8'))
  raw.exec('DROP INDEX IF EXISTS runs_read; PRAGMA user_version=30')
  const states = ['disconnected', 'connecting', 'ready', 'auth_required', 'host_verification_required', 'unsupported', 'error']
  for (const state of states) raw.run("INSERT INTO ssh_targets (id,label,destination,state,created_at) VALUES (?,?,?,?,'t')", [`t_${state}`, state, 'user@host.invalid', state])
  // the ambiguous one has a command still running on it (v30 cannot say whether the person or a shutdown stopped it)
  raw.exec("INSERT INTO projects (id,name,source_path,base_repo_path,kind,created_at,updated_at) VALUES ('p','p','/r','','direct','t','t'); INSERT INTO sessions (id,project_id,title,model,access_mode,created_at,updated_at) VALUES ('s','p','s','m','full','t','t');")
  raw.run("INSERT INTO executions (id,workspace_id,kind,command,cwd,status,created_at,isolation_json) VALUES ('x',NULL,'command','job','/r','running','t','{}')")
  raw.run("INSERT INTO remote_jobs (execution_id,target_id,root_id,generation,operation_id,state,connection_state) VALUES ('x','t_disconnected','root','gen','op','running','connected')")
  raw.close()
  const upgraded = connect(path)
  const fresh = connect(join(dir, 'fresh.db'))
  try {
    expect(upgraded.get('PRAGMA user_version')!.user_version).toBe(38)
    expect(structure(upgraded)).toEqual(structure(fresh))
    const intents = Object.fromEntries(upgraded.all('SELECT id,connect_intent FROM ssh_targets').map(r => [String(r.id), String(r.connect_intent)]))
    expect(intents).toEqual({ t_disconnected: 'none', t_connecting: 'connect', t_ready: 'connect', t_auth_required: 'connect', t_host_verification_required: 'connect', t_unsupported: 'connect', t_error: 'connect' })
    // the next start: the ambiguous target is never dialed (one Connect after the upgrade); a refusal for the person is
    // not dialed either; ready / connecting / error ones are
    const dialed: string[] = []
    const provider = (id: string): RemoteHostProvider => ({
      async probe() { dialed.push(id); return { capabilities: {} } },
      async listDirs() { throw new Error('unused') }, async openRoot() { throw new Error('unused') },
      async openForward() { throw new Error('unused') }, async closeForward() { return false }, async disconnect() {},
    })
    const service = new RemoteWorkspaceService(upgraded, target => provider(target.id), { steps_ms: [0], grace_ms: 1000 })
    expect(service.resume().sort()).toEqual(['t_connecting', 't_error', 't_ready'])
    await new Promise(r => setTimeout(r, 100))
    expect(dialed.sort()).toEqual(['t_connecting', 't_error', 't_ready'])
    expect(service.isPaused('t_disconnected')).toBe(true)
    expect(service.target('t_disconnected').state).toBe('disconnected')
    expect(upgraded.get("SELECT connection_state FROM remote_jobs WHERE execution_id='x'")!.connection_state).toBe('disconnected')
    await service.close()
  } finally { upgraded.close(); fresh.close() }
  const again = connect(path)
  try {
    expect(again.get('PRAGMA user_version')!.user_version).toBe(38)
    expect(again.get("SELECT connect_intent FROM ssh_targets WHERE id='t_disconnected'")!.connect_intent).toBe('none')
  } finally { again.close() }
})
