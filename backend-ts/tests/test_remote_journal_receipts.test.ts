/** Lost replies are reconciled only from remote operation receipts, never from same-path local bytes. */
import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { LoopbackSshd, inspectPid } from './remote/loopback_sshd.ts'
import { Client, json, makeApp } from './api_harness.ts'
import * as repo from '../src/db/repo.ts'
import { RemoteError } from '../src/remote/types.ts'
import type { Workspace } from '@oasis-code/contract'

for (const receiptKnown of [true, false]) test(`journal restart: remote receipt ${receiptKnown ? 'confirms applied and permits conditional undo' : 'stays unknown and forbids undo despite matching bytes'}`, async () => {
  const fixture=await LoopbackSshd.start({parent:tmpdir()})
  const options={remote_transport:{config_file:fixture.configFile,known_hosts_file:fixture.knownHostsFile,rpc_timeout_ms:10000},remote_reconnect:{settle_ms:1500}}
  let app=await makeApp(null,options), client=new Client(app), open=true
  try {
    writeFileSync(join(fixture.workspace,'note.txt'),'before\n')
    const target=await json(await client.post('/api/ssh/targets',{label:'Receipt',destination:fixture.alias,identity_file:fixture.clientKey}),201)
    await client.post(`/api/ssh/targets/${target.id}/connect`)
    const project=await json(await client.post('/api/projects',{source_path:fixture.workspace,mode:'direct',target:{kind:'ssh',target_id:target.id}}))
    const session=await json(await client.post(`/api/projects/${project.id}/sessions`,{title:'Receipt',model:'scripted:a'}))
    const ws=session.workspace as Workspace, runId='run_receipt_test'
    app.state.conn.run("INSERT INTO runs (id,session_id,project_id,workspace_id,model,user_text,status,created_at) VALUES (?,?,?,?,?,?,'done',?)",[runId,String(session.id),String(project.id),ws.id,'scripted:a','receipt',new Date().toISOString()])
    let writes=0
    const original=app.state.remote.request.bind(app.state.remote)
    app.state.remote.request=(async (...args:Parameters<typeof original>)=>{
      // while the reply is lost the receipt cannot be had either: the write's settle bound ends it as unknown
      if(writes&&args[1]==='operations.status') return {operation_id:(args[2] as {operation_id:string}).operation_id,state:'unknown'}
      const result=await original(...args)
      if(args[1]==='files.write'){writes++;throw new RemoteError('outcome_unknown','Lost reply after actual remote write','unknown')}
      return result
    }) as typeof original
    const files=app.state.workspaces.requireRemoteFiles()
    await expect(files.withLease(ws,'receipt_owner',lease=>files.write(ws,'note.txt',Buffer.from('after\n'),createHash('sha256').update('before\n').digest('hex'),{session_id:String(session.id),run_id:runId,tool_call_id:'write'},lease))).rejects.toMatchObject({code:'outcome_unknown'})
    app.state.remote.request=original
    expect(writes).toBe(1)
    expect(repo.listPreparedJournal(app.state.conn,runId)).toHaveLength(1)
    const settings=app.state.settings
    await app.close();open=false
    app=await makeApp(settings,options);open=true;client=new Client(app)
    await app.start()
    expect(repo.listPreparedJournal(app.state.conn,runId)).toHaveLength(1)
    expect(repo.listJournal(app.state.conn,{run_id:runId})).toHaveLength(0)
    expect(readFileSync(join(fixture.workspace,'note.txt'),'utf8')).toBe('after\n')
    const restored=app.state.remote.request.bind(app.state.remote)
    let queries=0, replayedWrites=0
    app.state.remote.request=(async (...args:Parameters<typeof restored>)=>{
      if(args[1]==='files.write') replayedWrites++
      if(args[1]==='operations.status') {
        queries++
        if(!receiptKnown) return {operation_id:(args[2] as {operation_id:string}).operation_id,state:'unknown'}
      }
      return restored(...args)
    }) as typeof restored
    await json(await client.post(`/api/ssh/targets/${target.id}/connect`))
    expect(queries).toBeGreaterThan(0);expect(replayedWrites).toBe(0)
    const undo=await json(await client.post(`/api/runs/${runId}/undo`))
    if(receiptKnown){
      expect(undo.restored).toEqual(['note.txt']);expect(undo.conflicts).toEqual([])
      expect(readFileSync(join(fixture.workspace,'note.txt'),'utf8')).toBe('before\n')
      expect(repo.listPreparedJournal(app.state.conn,runId)).toHaveLength(0)
      expect(replayedWrites).toBe(1) // the explicitly requested undo, not replay of the lost original write
    }else{
      expect(undo.restored).toEqual([]);expect(undo.conflicts).toHaveLength(1)
      expect(readFileSync(join(fixture.workspace,'note.txt'),'utf8')).toBe('after\n')
      expect(repo.listPreparedJournal(app.state.conn,runId)).toHaveLength(1)
      expect(replayedWrites).toBe(0)
      const lease=await restored(ws.remote!,'leases.inspect',{})
      expect(lease?.owner_id).toBe('receipt_owner')
    }
  } finally {
    if(open) await app.close()
    await fixture.close()
    console.log('JOURNAL_RECEIPT_OWNED_PIDS',JSON.stringify(fixture.ledger.map(p=>({pid:p.pid,label:p.label,ended:inspectPid(p.pid)===null}))))
  }
},60000)
