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
