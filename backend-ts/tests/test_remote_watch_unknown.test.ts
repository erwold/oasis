import { expect, test } from 'bun:test'
import { makeApp } from './api_harness.ts'
import * as repo from '../src/db/repo.ts'
import { createTarget } from '../src/db/remote_repo.ts'
import { WatchService } from '../src/agent/watches/service.ts'

async function fixture() {
  const app = await makeApp(), st = app.state
  const target = createTarget(st.conn, {label:'unknown',destination:'fixture.invalid'})
  const remote = {target_id:target.id,root_id:'root',generation:'generation',path:'/remote/not-local',state_path:'/remote/not-local/.oasis-remote'}
  const project = repo.createProject(st.conn,'remote',{kind:'direct',source_path:remote.path,base_repo_path:'',base_commit:null,base_branch:null,import_report:{},remote})
  const session=repo.createSession(st.conn,project.id,'watch','scripted:a')
  const ws=repo.insertWorkspace(st.conn,'ws_remote_watch',project.id,session.id,remote.path,'','','direct',null,remote)
  repo.setSessionWorkspace(st.conn,session.id,ws.id)
  st.conn.run("INSERT INTO runs (id,session_id,project_id,workspace_id,model,user_text,status,created_at) VALUES ('run_remote_watch',?,?,?,?,?,'done',?)",[session.id,project.id,ws.id,'scripted:a','watch',new Date().toISOString()])
  const execution=repo.insertExecution(st.conn,{run_id:'run_remote_watch',workspace_id:ws.id,tool_call_id:null,kind:'command',command:'remote job',cwd:remote.path,isolation:{runtime:'ssh'},network:true})
  st.conn.run("UPDATE executions SET status='running',effect_state='unknown' WHERE id=?",[execution.id])
  st.conn.run("INSERT INTO remote_jobs (execution_id,target_id,root_id,generation,operation_id,state,connection_state) VALUES (?,?,?,?,?,'unknown','disconnected')",[execution.id,target.id,remote.root_id,remote.generation,'op_watch'])
  return {app,st,session,ws,execution}
}

test('remote unknown is pending at register and startup, never a local ended/lost command',async()=>{
  const f=await fixture()
  try {
    expect(f.st.processes.isRunning(f.execution.id)).toBe(true)
    const watch=f.st.watches.register({session_id:f.session.id,run_id:'run_remote_watch',note:'wait',input:{kind:'exit',execution_id:f.execution.id}})
    expect('error' in watch).toBe(false)
    expect(repo.listWakeEvents(f.st.conn,f.session.id)).toHaveLength(0)
    f.st.watches.close()
    f.st.watches=new WatchService(f.st)
    const startup=f.st.watches.start()
    expect(startup.lost).toBe(0);expect(startup.ended).toBe(0)
    expect(repo.listWatches(f.st.conn,f.session.id)[0]!.status).toBe('active')
    expect(repo.listWakeEvents(f.st.conn,f.session.id)).toHaveLength(0)
    expect(f.st.processes.runningInWorkspace(f.ws.id)).toContain(f.execution.id)
  } finally {await f.app.close()}
})

test('remote disconnected time cannot satisfy a silence watch',async()=>{
  const f=await fixture(), now=Date.now
  try {
    const watch=f.st.watches.register({session_id:f.session.id,run_id:'run_remote_watch',note:'quiet',input:{kind:'silence',execution_id:f.execution.id,silence_s:30}})
    expect('error' in watch).toBe(false)
    Date.now=()=>now()+40000
    ;(f.st.watches as unknown as {tick():void}).tick()
    expect(repo.listWakeEvents(f.st.conn,f.session.id)).toHaveLength(0)
  } finally {Date.now=now;await f.app.close()}
})

test('progress source keeps authoritative exit state through an unavailable SSH final read, then recovers through the bound reader', async () => {
  const { parseUiSurfaceSpec } = await import('@oasis-code/contract')
  const { readChartSourcePage } = await import('../src/agent/ui_chart_sources.ts')
  const { RemoteRefused } = await import('../src/workspace/remote.ts')
  const f = await fixture()
  const original = f.st.workspaces.requireRemoteFiles
  try {
    const parsed = parseUiSurfaceSpec({ version: 1, surface_id: 'progress', title: 'Remote batch', fallback: 'Remote batch progress', kind: 'native', root: 'p',
      elements: { p: { type: 'progress', props: { source: { path: 'metrics.jsonl', format: 'jsonl', progress: { completed: 'done', execution_id: f.execution.id } } } } } })
    if (!parsed.ok) throw new Error(parsed.errors.join('\n'))
    repo.putUiSurface(f.st.conn, { session_id: f.session.id, run_id: 'run_remote_watch', surface_id: 'progress', revision: 1, spec: parsed.value, state: {}, model: 'scripted:a', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    f.st.workspaces.requireRemoteFiles = (() => ({ resolve: async () => { throw new RemoteRefused('remote_unavailable', 'fixture disconnected', 503) } })) as unknown as typeof original
    const read = () => readChartSourcePage(f.st, f.session.id, 'run_remote_watch', 'progress', 'p', { revision: 1, offset: 0 })
    expect(await read()).toMatchObject({ status: 'unavailable', execution: { status: 'unknown', exit_code: null } })
    for (const status of ['failed', 'succeeded', 'cancelled']) {
      repo.finishExecution(f.st.conn, f.execution.id, { status, exit_code: status === 'failed' ? 7 : 0, cancelled: status === 'cancelled', timed_out: false, truncated: false, stdout_asset_id: null, stderr_asset_id: null, stdout_bytes: 0, stderr_bytes: 0, duration_ms: 1 })
      expect(await read()).toMatchObject({ status: 'unavailable', execution: { status } })
    }
    const data = Buffer.from('{"done":4}\n').toString('base64')
    f.st.workspaces.requireRemoteFiles = (() => ({ resolve: async () => ({ exists: true, path: 'metrics.jsonl' }), remote: { request: async () => ({ file_id: 'fixture', size: 11, mtime_ms: 1, byte_offset: 0, next_offset: 11, eof: true, data, head: data, anchor: '', crc: null, crc_next: null }) } })) as unknown as typeof original
    expect(await read()).toMatchObject({ status: 'ok', data, execution: { status: 'cancelled' } })
  } finally { f.st.workspaces.requireRemoteFiles = original; await f.app.close() }
})
