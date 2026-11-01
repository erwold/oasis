import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { Conn, connect, SCHEMA_PATH } from '../src/db/database.ts'
import { getRunMeta, listRunMetas } from '../src/db/collab_repo.ts'
import * as repo from '../src/db/repo.ts'
import { RUN_READ_INDEX_SQL } from '../src/db/run_read_index.ts'
import { ProcessManager } from '../src/execution/processes.ts'

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
  test(`history emptiness keeps the exact old SQL meaning (${encoding}), not JSON emptiness`, () => {
    const db = new Database(':memory:')
    db.exec(`PRAGMA encoding='${encoding}'`)
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
    const conn = new Conn(db, ':memory:')
    try {
      // NULL/empty/[] alone are empty. Whitespace, invalid JSON, NUL, multibyte text and BLOBs keep their
      // original verdict; the byte guard must not accidentally turn a BLOB containing [] into TEXT equality.
      const values = [null, '', '[]', ' []', '[ ]', 'null', '{}', '0', '你好', '\u0000', '[]\u0000',
        '[' + ' '.repeat(100_000) + ']', 'x'.repeat(100_000), new Uint8Array(), new TextEncoder().encode('[]')]
      values.forEach((value, i) => conn.run(
        'INSERT INTO runs(id,session_id,project_id,model,user_text,status,created_at,history_json) VALUES(?,?,?,?,?,?,?,?)',
        [`r${i}`, 's', 'p', 'model', 'synthetic', 'done', 'same-time', value]))
      const oracle = conn.all("SELECT id, (history_json IS NULL OR history_json = '' OR history_json = '[]') AS empty FROM runs ORDER BY rowid")
      expect(listRunMetas(conn, 's').map(r => [r.id, r.history_empty])).toEqual(oracle.map(r => [String(r.id), Boolean(r.empty)]))
      for (const row of oracle) expect(getRunMeta(conn, String(row.id))!.history_empty).toBe(Boolean(row.empty))
      conn.run("UPDATE runs SET history_json='[]' WHERE id='r12'")
      expect(listRunMetas(conn, 's').find(r => r.id === 'r12')!.history_empty).toBe(true)
    } finally { conn.close() }
  })
}

test('session command lookup starts from remote jobs, preserves ownership, unknown states and execution order', () => {
  const conn = connect(':memory:')
  // All rows below are synthetic; no workspace, target, process or network connection is constructed.
  conn.exec('PRAGMA foreign_keys=OFF')
  try {
    conn.run("INSERT INTO workspaces(id,project_id,session_id,path,branch,base_commit,kind,created_at) VALUES('w','p','s','/synthetic','','','direct','t')")
    conn.run("INSERT INTO runs(id,session_id,project_id,model,user_text,status,created_at) VALUES('run-s','s','p','model','','done','t')")
    conn.run("INSERT INTO runs(id,session_id,project_id,model,user_text,status,created_at) VALUES('run-other','other','p','model','','done','t')")
    const rows = [
      ['z-first', 'w', null, 'unknown'], ['a-second', null, 'run-s', 'running'],
      ['other', null, 'run-other', 'unknown'], ['ended', 'w', null, 'succeeded'], ['local-only', 'w', null, 'running'],
    ] as const
    for (const [id, ws, run, status] of rows) conn.run(
      "INSERT INTO executions(id,workspace_id,run_id,kind,command,cwd,status,created_at) VALUES(?,?,?,'bash','synthetic','/synthetic',?,'t')", [id, ws, run, status])
    const manager: ProcessManager = Object.assign(Object.create(ProcessManager.prototype), {
      conn, live: new Map([
        ['live', { xid: 'live', exited: false, spec: { workspace_id: 'w', run_id: null } }],
        ['exited', { xid: 'exited', exited: true, spec: { workspace_id: 'w', run_id: null } }],
      ]), starting: new Map([['starting', { workspace_id: null, run_id: 'run-s' }]]),
    })
    let query = ''
    const all = conn.all.bind(conn)
    conn.all = ((sql: string, args?: unknown[]) => { if (sql.includes('CROSS JOIN executions')) query = sql; return all(sql, args as never) }) as Conn['all']
    expect(manager.runningForSession('s')).toEqual(['live', 'starting'])
    const plan = all(`EXPLAIN QUERY PLAN ${query}`).map(r => String(r.detail))
    expect(plan.some(s => /SCAN r\b/.test(s))).toBe(true)
    expect(plan.some(s => /SEARCH e\b/.test(s))).toBe(true)
    expect(plan.some(s => /SCAN e\b/.test(s))).toBe(false)
    // Reverse remote insertion order and lexical id order: the API still follows execution insertion order.
    for (const id of ['ended', 'other', 'a-second', 'z-first']) conn.run(
      "INSERT INTO remote_jobs(execution_id,target_id,root_id,generation,operation_id) VALUES(?,'target','root','generation',?)", [id, id])
    expect(manager.runningForSession('s')).toEqual(['live', 'starting', 'z-first', 'a-second'])
    expect(manager.runningForSession('other')).toEqual(['other'])
    conn.run("UPDATE executions SET status='cancelled' WHERE id='z-first'")
    expect(manager.runningForSession('s')).toEqual(['live', 'starting', 'a-second'])
  } finally { conn.close() }
})


test('covering metadata keeps equal-time order, fingerprint and transcript head semantics', () => {
  const conn = connect(':memory:')
  conn.exec('PRAGMA foreign_keys=OFF')
  try {
    conn.run("INSERT INTO sessions(id,project_id,title,model,created_at,updated_at) VALUES('s','p','synthetic','model','t','t')")
    for (const [id, status] of [['z-first', 'done'], ['a-second', 'running'], ['m-last', 'error']]) conn.run(
      "INSERT INTO runs(id,session_id,project_id,model,user_text,status,created_at,history_json,receipt_json) VALUES(?,'s','p','model','complete',?,'t',?,?)",
      [id!, status!, JSON.stringify([{ content: 'history '.repeat(20_000) }]), JSON.stringify({ final_text: 'whole receipt' })])
    // Frozen b5d0e4a columns/SQL on the OLD index set, independent of the production SQL-rewrite oracle.
    const columns = 'id, session_id, project_id, workspace_id, parent_run_id, resumes_run_id, spawned_by, label, model, model_config_json, user_text, status, usage_json, manifest_json, budget_json, receipt_json, error, created_at, finished_at, saved_seq, work_order_json, attachments_json, client_request_id, relay_id, relay_step, interaction_id, interaction_node'
    const qualified = columns.split(', ').map(c => `r.${c}`).join(', ')
    conn.exec('DROP INDEX runs_read')
    const before = conn.all(`SELECT ${columns} FROM runs WHERE session_id=? ORDER BY created_at`, ['s']).map(r => String(r.id))
    const threadBefore = conn.all(`SELECT ${columns} FROM runs WHERE session_id=? AND parent_run_id IS NULL AND work_order_json IS NULL AND spawned_by IN ('human','wake','connector') ORDER BY created_at`, ['s']).map(r => String(r.id))
    const latestBefore = conn.get(`SELECT ${qualified} FROM runs r JOIN sessions s ON s.id = r.session_id WHERE r.session_id=? AND r.parent_run_id IS NULL AND r.work_order_json IS NULL AND r.spawned_by IN ('human','wake','connector') AND (r.workspace_id IS NULL OR s.workspace_id IS NULL OR r.workspace_id = s.workspace_id) ORDER BY r.created_at DESC LIMIT 1`, ['s'])!
    const statuses = ['running', 'error', 'done']
    const statusBefore = conn.all(`SELECT ${columns} FROM runs WHERE status IN (?,?,?) ORDER BY created_at`, statuses).map(r => String(r.id))
    conn.exec(RUN_READ_INDEX_SQL)
    expect(repo.listRuns(conn, 's').map(r => r.id)).toEqual(before)
    expect(repo.listThreadRuns(conn, 's').map(r => r.id)).toEqual(threadBefore)
    expect(listRunMetas(conn, 's').map(r => r.id)).toEqual(before)
    expect(repo.latestRunOfSession(conn, 's')!.id).toBe(String(latestBefore.id))
    expect(repo.listRunsWithStatus(conn, statuses).map(r => r.id)).toEqual(statusBefore)
    for (const id of before) {
      const full = repo.getRun(conn, id)!
      expect(repo.getTranscriptRun(conn, id)).toEqual({ id: full.id, session_id: full.session_id, model: full.model, status: full.status, resumes_run_id: full.resumes_run_id })
    }
    expect(repo.getTranscriptRun(conn, 'absent')).toBeNull()
    // The index stores derived facts only. Changes remain visible, including receipt-only and history-only writes.
    repo.setRunReceipt(conn, 'z-first', { final_text: 'changed' })
    repo.saveRunProgress(conn, 'a-second', '[]', { requests: 3 }, 7)
    expect(getRunMeta(conn, 'z-first')!.final_text_chars).toBe(7)
    expect(listRunMetas(conn, 's').find(r => r.id === 'a-second')!.history_empty).toBe(true)
    const lookup = conn.all('EXPLAIN QUERY PLAN SELECT id FROM runs WHERE id=?', ['z-first']).map(r => String(r.detail))
    expect(lookup.some(r => r.includes('sqlite_autoindex_runs_1'))).toBe(true)
  } finally { conn.close() }
})
