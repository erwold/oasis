/** Real product API + ProcessManager + WatchService over an owned system sshd. No pod/8399. */
import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { Client, json, makeApp } from './api_harness.ts'
import { setModel, sleep } from './harness.ts'
import { scriptedModel } from '../src/llm/scripted.ts'
import { modelResponse, textPart } from '../src/llm/messages.ts'
import * as repo from '../src/db/repo.ts'
import { ExecutionSchema, OutputWindowSchema } from '@oasis-code/contract'

async function until(check: () => boolean, milliseconds = 15000) {
  const end = Date.now()+milliseconds
  while (!check()) { if (Date.now()>end) throw new Error('Timed out waiting for persisted remote outcome'); await sleep(50) }
}

test('remote API command survives disconnect; persisted match/exit fire once; Full has no implicit caps', async () => {
  const fixture=await LoopbackSshd.start({parent:tmpdir()})
  const app=await makeApp(null,{remote_transport:{config_file:fixture.configFile,known_hosts_file:fixture.knownHostsFile,rpc_timeout_ms:10000},watches:{tick_ms:100,debounce_ms:50}})
  const c=new Client(app); let xid='', targetId=''
  try {
    await app.start()
    setModel(app.state,'scripted:a',scriptedModel(()=>modelResponse([textPart('Observed remote command.')])) )
    const target=await json(await c.post('/api/ssh/targets',{label:'Job fixture',destination:fixture.alias,identity_file:fixture.clientKey}),201)
    targetId=String(target.id); await json(await c.post(`/api/ssh/targets/${targetId}/connect`))
    const project=await json(await c.post('/api/projects',{target:{kind:'ssh',target_id:targetId},source_path:fixture.workspace,mode:'direct'}))
    const session=await json(await c.post(`/api/projects/${project.id}/sessions`,{title:'Job watch',model:'scripted:a'}))
    const workspace=session.workspace as {id:string}
    const started=await json(await c.post(`/api/workspaces/${workspace.id}/commands`,{command:"sleep 2; printf '中文_READY\\n'; sleep 3; printf 'FINAL\\n'; exit 7",access:'session',session_id:session.id,wait_s:1}))
    xid=String(started.execution_id)
    expect(started.running).toBe(true); expect(started.timeout_s).toBeNull(); expect(started.output_cap_bytes).toBeNull()
    const first=app.state.conn.get('SELECT * FROM remote_jobs WHERE execution_id=?',[xid])!
    expect(first.job_id).toBeTruthy()
    const runId='run_remote_watch_product'
    app.state.conn.run("INSERT INTO runs (id,session_id,project_id,workspace_id,model,user_text,status,created_at) VALUES (?,?,?,?,?,?,'done',?)",[runId,String(session.id),String(project.id),workspace.id,'scripted:a','Watch remote command.',new Date().toISOString()])
    for (const input of [{kind:'match' as const,execution_id:xid,pattern:'中文_READY'},{kind:'exit' as const,execution_id:xid}]) {
      const watch=app.state.watches.register({session_id:String(session.id),run_id:runId,note:'Record the remote event.',input})
      expect('error' in watch).toBe(false)
    }
    await c.post(`/api/ssh/targets/${targetId}/disconnect`)
    await sleep(2100)
    const offline=await json(await c.get(`/api/executions/${xid}`))
    expect(offline.status).toBe('unknown');expect(offline.connection_state).toBe('disconnected');expect(offline.exit_code).toBeNull()
    expect(ExecutionSchema.safeParse(offline).success).toBe(true)
    expect(offline.target).toEqual({kind:'ssh',target_id:targetId})
    const unavailable=await json(await c.get(`/api/executions/${xid}/output`,{stream:'stdout',offset:0,limit:64}))
    expect(unavailable.available).toBe(false);expect(unavailable.total_bytes).toBeNull();expect(unavailable.eof).toBe(false);expect(unavailable.next_offset).toBe(0)
    expect(OutputWindowSchema.safeParse(unavailable).success).toBe(true)
    expect(repo.listWakeEvents(app.state.conn,String(session.id))).toHaveLength(0)
    expect(app.state.processes.runningInWorkspace(workspace.id)).toContain(xid)
    await json(await c.post(`/api/ssh/targets/${targetId}/connect`))
    await until(()=>!app.state.processes.isRunning(xid))
    await until(()=>repo.listWatches(app.state.conn,String(session.id)).every(w=>w.status==='done'))
    const finished=await json(await c.get(`/api/executions/${xid}`))
    expect(finished.status).toBe('failed');expect(finished.exit_code).toBe(7)
    const output=await json(await c.get(`/api/executions/${xid}/output`,{stream:'stdout',offset:0,limit:65536}))
    expect(output.text).toContain('中文_READY');expect(output.text).toContain('FINAL')
    expect(repo.listWakeEvents(app.state.conn,String(session.id)).filter(e=>e.kind==='fired')).toHaveLength(2)
    expect(app.state.conn.get('SELECT job_id FROM remote_jobs WHERE execution_id=?',[xid])!.job_id).toBe(first.job_id)
    await app.state.remote_driver.poll(xid)
    expect(repo.listWakeEvents(app.state.conn,String(session.id)).filter(e=>e.kind==='fired')).toHaveLength(2)
  } finally {
    if (xid && app.state.processes.isRunning(xid)) { await app.state.remote.connect(targetId); await app.state.remote_driver.stop(xid); await app.state.remote_driver.wait(xid,10) }
    await app.close(); await fixture.close()
    console.log('REMOTE_JOB_OWNED_PIDS',JSON.stringify(fixture.ledger.map(p=>({pid:p.pid,label:p.label,ended:inspectPid(p.pid)===null}))))
  }
  expect(existsSync(fixture.root)).toBe(false)
},60000)

test('backend restart rehydrates the same durable job and keeps exit watch and writer pin without replay', async () => {
  const fixture=await LoopbackSshd.start({parent:tmpdir()})
  const options={remote_transport:{config_file:fixture.configFile,known_hosts_file:fixture.knownHostsFile,rpc_timeout_ms:10000},watches:{tick_ms:100,debounce_ms:50}}
  let app=await makeApp(null,options), c=new Client(app), open=true, xid='', targetId=''
  const settings=app.state.settings
  try {
    await app.start()
    const target=await json(await c.post('/api/ssh/targets',{label:'Restart',destination:fixture.alias,identity_file:fixture.clientKey}),201)
    targetId=String(target.id);await c.post(`/api/ssh/targets/${targetId}/connect`)
    const p=await json(await c.post('/api/projects',{mode:'direct',source_path:fixture.workspace,target:{kind:'ssh',target_id:targetId}}))
    const s=await json(await c.post(`/api/projects/${p.id}/sessions`,{title:'restart',model:'scripted:a'})), ws=s.workspace as {id:string}
    const start=await json(await c.post(`/api/workspaces/${ws.id}/commands`,{command:"printf X >> once.txt; printf 'before\\n'; sleep 4; printf 'after\\n'; exit 0",access:'session',session_id:s.id,wait_s:1}))
    xid=String(start.execution_id)
    const job=app.state.conn.get('SELECT job_id FROM remote_jobs WHERE execution_id=?',[xid])!.job_id
    const runId='run_restart_watch'
    app.state.conn.run("INSERT INTO runs (id,session_id,project_id,workspace_id,model,user_text,status,created_at) VALUES (?,?,?,?,?,?,'done',?)",[runId,String(s.id),String(p.id),ws.id,'scripted:a','restart watch',new Date().toISOString()])
    expect('error' in app.state.watches.register({session_id:String(s.id),run_id:runId,note:'Observe the same job.',input:{kind:'exit',execution_id:xid}})).toBe(false)
    await app.close();open=false
    app=await makeApp(settings,options);open=true;c=new Client(app)
    setModel(app.state,'scripted:a',scriptedModel(()=>modelResponse([textPart('Recovered job.')])) )
    await app.start()
    expect(repo.getExecution(app.state.conn,xid)!.status).not.toBe('lost')
    expect(app.state.processes.isRunning(xid)).toBe(true)
    expect(app.state.locks.state(ws.id).holder?.execution_ids).toContain(xid)
    expect(repo.listWakeEvents(app.state.conn,String(s.id))).toHaveLength(0)
    await json(await c.post(`/api/ssh/targets/${targetId}/connect`))
    await until(()=>!app.state.processes.isRunning(xid))
    await until(()=>repo.listWakeEvents(app.state.conn,String(s.id)).some(e=>e.kind==='fired'))
    expect(app.state.conn.get('SELECT job_id FROM remote_jobs WHERE execution_id=?',[xid])!.job_id).toBe(job)
    expect(readFileSync(join(fixture.workspace,'once.txt'),'utf8')).toBe('X')
    expect(repo.getExecution(app.state.conn,xid)!.status).toBe('succeeded')
    await app.state.remote_driver.poll(xid)
    expect(repo.listWakeEvents(app.state.conn,String(s.id)).filter(e=>e.kind==='fired')).toHaveLength(1)
  } finally {
    if(open) {if(xid&&app.state.processes.isRunning(xid)){await app.state.remote.connect(targetId);await app.state.remote_driver.stop(xid);await app.state.remote_driver.wait(xid,10)} await app.close()}
    await fixture.close()
    console.log('REMOTE_RESTART_OWNED_PIDS',JSON.stringify(fixture.ledger.map(p=>({pid:p.pid,label:p.label,ended:inspectPid(p.pid)===null}))))
  }
},60000)
