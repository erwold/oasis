/** The file journal of a folder edited in place, through the production path: WorkspaceService.directProject /
 *  createWorkspace, then each write as the file tool makes it (src/agent/tools/files.ts: journal.prepare, atomicWrite
 *  with the expected sha, journal.applied), then the reads the page and an undo make — FileJournal.folderChanges
 *  (status and diff of the folder), runChanges, diffOf and undoRun.
 *
 *  Scenarios: `spread` (W writes, each to its own file) and `same_path` (W writes to one file: FileJournal.group copies
 *  the path's list on every entry, which this measures as W grows). Recorded: ms of the reads, the database's growth
 *  per write (each entry keeps the file before and after, whole). Only the scratch folder is written.
 *
 *  Env: PERF_SCRATCH, PERF_OUT, PERF_SCALE=small|large (same_path 1k | 10k writes), PERF_SAMPLES. */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from '../../src/db/database.ts'
import * as repo from '../../src/db/repo.ts'
import { Settings } from '../../src/config.ts'
import { WorkspaceService } from '../../src/workspace/service.ts'
import { fileNow } from '../../src/workspace/journal.ts'
import { atomicWrite, sha256Hex } from '../../src/store.ts'
import { assertFree, bench, dirFromEnv, genBudgetBytes, du, fileBytes, fingerprint, intFromEnv, main, timeOnce, writeResult } from './common.ts'

const SCALE = process.env.PERF_SCALE === 'large' ? 'large' : 'small'
const SCENARIOS = SCALE === 'large'
  ? [{ name: 'spread', writes: 5000, files: 5000, bytes: 4096 }, { name: 'same_path', writes: 1000, files: 1, bytes: 4096 }, { name: 'same_path', writes: 10000, files: 1, bytes: 4096 }, { name: 'same_path', writes: 1000, files: 1, bytes: 65536 }]
  : [{ name: 'spread', writes: 500, files: 500, bytes: 4096 }, { name: 'same_path', writes: 100, files: 1, bytes: 4096 }, { name: 'same_path', writes: 1000, files: 1, bytes: 4096 }]

main(async () => {
  const scratch = dirFromEnv('PERF_SCRATCH')
  const samples = intFromEnv('PERF_SAMPLES', 10)
  const out: Record<string, unknown>[] = []
  for (const sc of SCENARIOS) {
    // each write keeps the file before and after in the database, and the file itself: about three times its bytes
    const estimate = sc.writes * sc.bytes * 3
    if (estimate > genBudgetBytes()) { out.push({ scenario: sc.name, writes: sc.writes, file_bytes: sc.bytes, skipped: 'over the generated-data budget', estimate_bytes: estimate }); continue }
    assertFree(scratch, estimate, `journal ${sc.name} ${sc.writes}`)
    const root = join(scratch, `journal-${sc.name}-${sc.writes}-${sc.bytes}`)
    rmSync(root, { recursive: true, force: true })
    const folder = join(root, 'folder')
    mkdirSync(folder, { recursive: true })
    const settings = new Settings({ data_dir: join(root, 'data'), config_path: join(root, 'config.json') })
    const conn = connect(settings.db_path)
    const service = new WorkspaceService(settings, conn)
    const project = await service.directProject('synthetic', folder)
    const session = repo.createSession(conn, project.id, 's', 'synthetic:model')
    const ws = await service.createWorkspace(project, session.id)
    const runId = repo.insertRun(conn, { session_id: session.id, project_id: project.id, workspace_id: ws.id, model: 'synthetic:model', model_config: {}, user_text: 'synthetic', status: 'running', budget: {} }).id
    const dbBefore = fileBytes(settings.db_path) + fileBytes(`${settings.db_path}-wal`)
    const perWrite: number[] = []
    for (let i = 0; i < sc.writes; i += 1) {
      const rel = sc.files === 1 ? 'same.txt' : `d${i % 20}/f${i}.txt`
      const data = new TextEncoder().encode(`${i}\n`.padEnd(sc.bytes, 'y'))
      const t0 = performance.now()
      const now = fileNow(ws.path, rel)
      const before = now.kind === 'file' ? now.data : null
      const entry = service.journal.prepare(ws, { run_id: runId, tool_call_id: `t${i}`, path: rel, action: 'edited', before, intended: data })
      atomicWrite(join(ws.path, rel), data, { expect: before === null ? { absent: true } : { sha256: sha256Hex(before) }, keep_mode: true })
      service.journal.applied(entry, data)
      perWrite.push(performance.now() - t0)
    }
    const dbAfter = fileBytes(settings.db_path) + fileBytes(`${settings.db_path}-wal`)
    const writes = perWrite.sort((a, b) => a - b)
    const row: Record<string, unknown> = {
      scenario: sc.name, writes: sc.writes, files: sc.files, file_bytes: sc.bytes,
      write_ms: { p50: writes[Math.floor(writes.length / 2)], p95: writes[Math.floor(writes.length * 0.95)], total: Math.round(writes.reduce((a, b) => a + b, 0)) },
      db_growth_bytes: dbAfter - dbBefore, db_growth_per_write: Math.round((dbAfter - dbBefore) / sc.writes),
      folderChanges: { ms: (await bench(() => service.journal.folderChanges(ws), { n: samples })).ms },
      runChanges: { ms: (await bench(() => service.journal.runChanges(runId), { n: samples })).ms },
      status: { ms: (await bench(() => service.status(ws), { n: samples })).ms },
      diff: { ms: (await bench(() => service.diff(ws), { n: Math.min(samples, 5) })).ms },
    }
    const undo = timeOnce(() => service.journal.undoRun(ws, runId, session.id))
    row.undoRun = { ms: undo.ms, restored: undo.value.restored.length, removed: undo.value.removed.length, conflicts: undo.value.conflicts.length }
    row.folder = du(folder)
    out.push(row)
    service.close()
    conn.close()
    rmSync(root, { recursive: true, force: true })
  }
  writeResult(`file_journal_bench_${SCALE}`, { kind: 'file_journal', scale: SCALE, fingerprint: fingerprint(), scenarios: out })
})
