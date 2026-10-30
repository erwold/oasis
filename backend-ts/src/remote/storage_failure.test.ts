import { test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { loopbackFixture } from './loopback.fixture.ts'
import { storageFaultPython } from './storage_fault.fixture.ts'
import type { RemoteJob } from './types.ts'
const exec=promisify(execFile)

test('real SSH storage faults: post-spawn receipt, log fsync, terminal retry never orphan the command',async()=>{
  const f=await loopbackFixture()
  try {
    for(const mode of ['running','log','terminal'] as const) {
      const t=f.transport('loopback-a',{python:storageFaultPython(f.dir,mode)})
      const root=await t.openRoot({path:f.project})
      const lease=await t.request(root,'leases.acquire',{owner_id:'storage-'+mode},randomUUID())
      const command=mode==='terminal'?'printf finished':`printf started; sleep 1; printf orphan > SHOULD_NOT_RUN_${mode}`
      const started=await t.request(root,'jobs.start',{command,lease},randomUUID())
      let ended:RemoteJob|undefined
      for(let i=0;i<60;i++) {
        const status=await t.request(root,'jobs.status',{job_id:started.job_id})
        if(status.state==='exited'){ended=status;break}
        await Bun.sleep(100)
      }
      expect(ended).toBeDefined();expect(ended!.reason).toBe('storage_failed');expect(ended!.terminal_confirmed).toBe(true)
      expect(ended!.log_complete).toBe(false)
      if(mode!=='terminal')expect(ended!.signal).toBe(9)
      const path=root.state_path+'/jobs/'+started.job_id
      expect(existsSync(path+'/exit.json')).toBe(false)
      const failure=JSON.parse(readFileSync(path+'/storage-failed.json','utf8'))
      expect(failure.terminal_confirmed).toBe(true)
      const log=await t.request(root,'jobs.read',{job_id:started.job_id,stream:'stdout'})
      expect(log.eof).toBe(true);expect(log.storage_failed).toBe(true);expect(log.log_complete).toBe(false)
      const identity=JSON.parse(readFileSync(path+'/fault-identity.json','utf8'))
      let actual=''
      try { actual=(await exec('/bin/ps',['-p',String(identity.pid_identity.pid),'-o','lstart=','-o','command='])).stdout.trim() } catch {}
      expect(actual && actual.slice(0,24)===identity.pid_identity.identity.slice(0,24)).toBeFalsy()
      console.log('STORAGE_FAULT_REAPED',JSON.stringify({mode,job_id:started.job_id,child_pid:identity.pid_identity.pid,supervisor_pid:identity.supervisor_pid,reason:ended!.reason,signal:ended!.signal}))
      await Bun.sleep(1100)
      if(mode!=='terminal')expect(existsSync(f.project+'/SHOULD_NOT_RUN_'+mode)).toBe(false)
      expect((await t.request(root,'leases.release',{lease},randomUUID())).released).toBe(true)
      await t.disconnect()
    }
  } finally { await f.close() }
},120000)
