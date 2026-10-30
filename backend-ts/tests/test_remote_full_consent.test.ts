import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { connect } from '../src/db/database.ts'
import * as repo from '../src/db/repo.ts'
import { tempDir } from './helpers.ts'
// The optional path is a test-only way to run the identical assertions against the prior committed module.
const { fullAccessConfirmed, fullAccessRequest } = await import(process.env.TEST_REMOTE_CONSENT_MODULE ?? '../src/agent/ui_inputs.ts')
const a={target_id:'ssh_a',root_id:'root',generation:'generation',path:'/same/path',label:'SSH A'}
function fixture(){
  const conn=connect(join(tempDir('remote-consent-'),'db'))
  const p=repo.createProject(conn,'fixture',{source_path:null,base_repo_path:'',base_commit:null,base_branch:null,import_report:{}})
  const s=repo.createSession(conn,p.id,'fixture','scripted:a')
  conn.run("INSERT INTO runs (id,session_id,project_id,model,user_text,status,created_at) VALUES ('run_consent',?,?,?,'','done',?)",[s.id,p.id,'scripted:a',new Date().toISOString()])
  return { conn, s, approve: (scope?: typeof a) => {
    const input=repo.insertUiInput(conn,{session_id:s.id,run_id:'run_consent',tool_call_id:'consent',request:fullAccessRequest(scope)})
    repo.answerUiInput(conn,input.id,{status:'submitted',values:{access:'full'}})
  } }
}

test('local Full consent does not approve an SSH target; an SSH host is confirmed once, whatever its folder or connection',()=>{
  const f=fixture()
  try {
    f.approve()
    expect(fullAccessConfirmed(f.conn,false)).toBe(true)
    expect(fullAccessConfirmed(f.conn,false,a)).toBe(false)
    f.approve(a)
    expect(fullAccessConfirmed(f.conn,false,a)).toBe(true)
    // the same host: another folder (another session's root), a new connection
    expect(fullAccessConfirmed(f.conn,false,{...a,generation:'replaced'})).toBe(true)
    expect(fullAccessConfirmed(f.conn,false,{...a,root_id:'other',path:'/elsewhere'})).toBe(true)
    // another host is asked again
    expect(fullAccessConfirmed(f.conn,false,{...a,target_id:'ssh_b'})).toBe(false)
  }finally{f.conn.close()}
})

test('a host declined is not confirmed; a yes on one host answers what waits for that host only',async()=>{
  const f=fixture()
  try {
    const declined=repo.insertUiInput(f.conn,{session_id:f.s.id,run_id:'run_consent',tool_call_id:'d',request:fullAccessRequest(a)})
    repo.answerUiInput(f.conn,declined.id,{status:'dismissed',values:null})
    expect(fullAccessConfirmed(f.conn,false,a)).toBe(false)
    const { answerOtherFullAccessAsks, awaitAnswer } = await import('../src/agent/ui_inputs.ts')
    const waiting = (scope?: typeof a) => {
      const input=repo.insertUiInput(f.conn,{session_id:f.s.id,run_id:'run_consent',tool_call_id:`w_${Math.random()}`,request:fullAccessRequest(scope)})
      const stop=new AbortController()
      return { id: input.id, stop, answer: awaitAnswer(f.conn,input.id,stop.signal,() => 'cancelled') }
    }
    const sameHost=waiting({...a,root_id:'another session root',generation:'g2'})
    const otherHost=waiting({...a,target_id:'ssh_b'})
    const local=waiting()
    answerOtherFullAccessAsks(f.conn,'uin_the_yes','ssh_a')
    const answered=await sameHost.answer
    expect([answered.status, answered.values?.access]).toEqual(['submitted','full'])
    expect(repo.getUiInput(f.conn,otherHost.id)!.status).toBe('pending')
    expect(repo.getUiInput(f.conn,local.id)!.status).toBe('pending')
    otherHost.stop.abort(); local.stop.abort()
  }finally{f.conn.close()}
})

test('remote Full consent neither approves local commands nor offers fictitious Sandbox',()=>{
  const f=fixture()
  try {
    f.approve(a)
    expect(fullAccessConfirmed(f.conn,false)).toBe(false)
    const form=fullAccessRequest(a)
    expect(form.title).toBe('Full access')
    expect(form.message).toContain('SSH A')
    expect(JSON.stringify(form.elements)).not.toContain('Sandbox')
    expect(form.remote_generation).toBe(a.generation)
  }finally{f.conn.close()}
})
