import { test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, mkdirSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { loopbackFixture } from './loopback.fixture.ts'
import { FrameDecoder, encodeFrame } from './protocol.ts'
import type { SshTransport } from './transport.ts'
import type { RemoteRoot } from './types.ts'
const op=()=>randomUUID(), data=(s:string)=>Buffer.from(s).toString('base64')
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
async function terminal(t:SshTransport,r:RemoteRoot,id:string) {
  for(let i=0;i<80;i++) { const j=await t.request(r,'jobs.status',{job_id:id}); if(j.state==='exited') return j; await Bun.sleep(100) }
  throw new Error('No trusted terminal record')
}
async function canConnect(port:number) { return await new Promise<boolean>(r=>{const s=connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true)});s.once('error',()=>r(false))}) }
test('protocol fragmentation, binary-safe payload, pollution and oversize fail closed',()=>{
  const value={binary:Buffer.from([0,255,13,10]).toString('base64'),unicode:'汉字🙂'}, frame=encodeFrame(value), d=new FrameDecoder(), out:unknown[]=[]
  for(const byte of frame) out.push(...d.push(Buffer.from([byte])))
  d.end();expect(out).toEqual([value])
  expect(()=>new FrameDecoder().push(Buffer.from('banner!!'))).toThrow()
  const bad=Buffer.alloc(8);bad.write('OSR1');bad.writeUInt32BE(99999999,4)
  expect(()=>new FrameDecoder().push(bad)).toThrow()
  const partial=new FrameDecoder();partial.push(frame.subarray(0,-1));expect(()=>partial.end()).toThrow()
})
test('real OpenSSH: probe, files, lease aliases, durable jobs, limits, safe stop, forward and config hardening',async()=>{
  const f=await loopbackFixture()
  try {
    const t=f.transport(), alias=f.transport('loopback-b')
    const p=await t.probe();expect(p.exec).toBe(true);expect(p.platform).toBe(process.platform==='darwin'?'darwin':'linux')
    await t.listDirs(f.project)
    expect(readdirSync(f.project)).toEqual([]);expect(readdirSync(f.home)).toEqual([])
    const untrusted=f.transport('loopback-a',{known_hosts_file:f.dir+'/empty_known_hosts'})
    await expect(untrusted.probe()).rejects.toMatchObject({code:'host_verification_required'})
    const r=await t.openRoot({path:f.project}), r2=await alias.openRoot({path:f.project})
    expect(r2.root_id).toBe(r.root_id);expect(r2.generation).toBe(r.generation)
    const lease=await t.request(r,'leases.acquire',{owner_id:'test'},op())
    await expect(alias.request(r2,'leases.acquire',{owner_id:'other'},op())).rejects.toMatchObject({code:'lease_conflict'})
    await expect(t.request({...r,generation:'stale'},'files.list',{path:'.'})).rejects.toMatchObject({code:'root_changed'})
    const writeOp=op(), params={path:'file.txt',expected_hash:null,data:data('hello 汉字🙂\n'),lease}
    const written=await t.request(r,'files.write',params,writeOp)
    expect(written.before).toBeNull();expect(written.after_sha256).toBe(hash('hello 汉字🙂\n'))
    expect(await t.request(r,'files.write',params,writeOp)).toEqual(written)
    await expect(t.request(r,'files.write',{...params,data:data('changed')},writeOp)).rejects.toMatchObject({code:'operation_conflict'})
    expect((await t.request(r,'operations.status',{operation_id:writeOp})).state).toBe('applied')
    await expect(t.request(r,'files.write',{...params,expected_hash:'wrong'},op())).rejects.toMatchObject({code:'version_conflict'})
    const edit=await t.request(r,'files.edit',{path:'file.txt',expected_hash:written.after_sha256!,old_string:'hello',new_string:'bye',lease},op())
    expect(Buffer.from(edit.before!,'base64').toString()).toBe('hello 汉字🙂\n')
    const decoder=new TextDecoder(), pieces:string[]=[];let offset=0
    while(true){const page=await t.request(r,'files.read',{path:'file.txt',byte_offset:offset,limit:2,expected_hash:edit.after_sha256!});pieces.push(decoder.decode(Buffer.from(page.data,'base64'),{stream:!page.eof}));offset=page.next_offset;if(page.eof)break}
    expect(pieces.join('')).toBe('bye 汉字🙂\n')
    const listing=await t.request(r,'files.list',{path:'.'});expect(listing.entries.some(e=>e.path.includes('.oasis-remote'))).toBe(false)
    expect((await t.request(r,'files.search',{path:'file.txt',query:'汉字'})).matches).toEqual([4])
    await expect(t.request(r,'files.read',{path:'.oasis-remote/root.json'})).rejects.toMatchObject({code:'path_refused'})
    symlinkSync(f.home,f.project+'/escape');await expect(t.request(r,'files.read',{path:'escape/nope'})).rejects.toBeDefined()
    await expect(t.request(r,'files.write',{path:'large',expected_hash:null,data:Buffer.alloc(2*1024*1024+1).toString('base64'),lease},op())).rejects.toMatchObject({code:'file_too_large'})
    const removed=await t.request(r,'files.remove',{path:'file.txt',expected_hash:edit.after_sha256!,lease},op());expect(removed.after).toBeNull()
    const jobOp=op(), jobParams={command:"printf 'once\\n' >> count; printf '汉字🙂'; sleep 1; printf 'done'; printf 'err' >&2; exit 17",lease}
    const job=await t.request(r,'jobs.start',jobParams,jobOp);expect(job.job_id).toMatch(/^[a-f0-9]{32}$/);expect(job.timeout_s).toBeNull();expect(job.output_cap_bytes).toBeNull()
    expect((await t.request(r,'jobs.start',jobParams,jobOp)).job_id).toBe(job.job_id)
    await t.disconnect()
    const recovered=await alias.request(r2,'jobs.recover',{operation_id:jobOp});expect(recovered.job_id).toBe(job.job_id)
    const ended=await terminal(alias,r2,job.job_id);expect(ended.exit_code).toBe(17)
    expect(readFileSync(f.project+'/count','utf8')).toBe('once\n')
    let log='', cursor=0;const utf8=new TextDecoder()
    while(true){const page=await alias.request(r2,'jobs.read',{job_id:job.job_id,stream:'stdout',byte_offset:cursor,limit:2});log+=utf8.decode(Buffer.from(page.data,'base64'),{stream:!page.eof});cursor=page.next_offset;if(page.eof)break}
    expect(log).toBe('汉字🙂done')
    const uncapped=await alias.request(r2,'jobs.start',{command:"python3 -B -I -c 'import sys;sys.stdout.write(\"x\"*400000)'",lease},op())
    expect((await terminal(alias,r2,uncapped.job_id)).stdout_bytes).toBe(400000)
    const capped=await alias.request(r2,'jobs.start',{command:"python3 -B -I -c 'import sys;sys.stdout.write(\"y\"*400000)'",output_cap_bytes:1000,lease},op())
    await terminal(alias,r2,capped.job_id)
    const cp=await alias.request(r2,'jobs.read',{job_id:capped.job_id,stream:'stdout'});expect(cp.total_retained).toBe(1000);expect(cp.gaps.length).toBe(1)
    const timed=await alias.request(r2,'jobs.start',{command:'sleep 10',timeout_s:0.2,lease},op());expect((await terminal(alias,r2,timed.job_id)).reason).toBe('timeout')
    const stopping=await alias.request(r2,'jobs.start',{command:'sleep 10',lease},op())
    await expect(alias.request(r2,'leases.release',{lease},op())).rejects.toMatchObject({code:'outcome_unknown'})
    await alias.request(r2,'jobs.stop',{job_id:stopping.job_id,signal:'SIGTERM'},op());expect((await terminal(alias,r2,stopping.job_id)).signal).toBe(15)
    // An intent with no trusted completion must not be re-executed. Fault state is test-owned.
    const unknownOp=op();writeFileSync(r.state_path+'/operations/'+unknownOp+'.json',JSON.stringify({operation_id:unknownOp,state:'prepared',digest:'unknown'}))
    expect((await alias.request(r2,'operations.status',{operation_id:unknownOp})).state).toBe('prepared')
    await expect(alias.request(r2,'jobs.recover',{operation_id:unknownOp})).rejects.toMatchObject({code:'outcome_unknown'})
    await expect(alias.request(r2,'leases.release',{lease},op())).rejects.toMatchObject({code:'outcome_unknown'})
    const echo=createServer(s=>s.pipe(s));await new Promise<void>(r=>echo.listen(0,'127.0.0.1',r))
    try{
      const remotePort=(echo.address() as {port:number}).port
      const forward=await alias.openForward(remotePort);expect(alias.listForwards()).toHaveLength(1)
      const exchange=async(port:number)=>await new Promise<string>((resolve,reject)=>{const s=connect(port,'127.0.0.1',()=>s.write('forward-binary-汉字'));s.once('data',b=>{s.destroy();resolve(b.toString())});s.once('error',reject)})
      expect(await exchange(forward.local_port)).toBe('forward-binary-汉字')
      // Check while a real -W channel remains live, not after ssh already exited.
      const held=connect(forward.local_port,'127.0.0.1')
      await new Promise<void>((resolve,reject)=>{held.once('connect',()=>held.write('hold'));held.once('data',()=>resolve());held.once('error',reject)})
      try { for(const port of [f.localExtra,f.remoteExtra,f.dynamicExtra])expect(await canConnect(port)).toBe(false) }
      finally { held.destroy() }
      const again=await alias.reconnectForward(forward.id);expect(await exchange(again.local_port)).toBe('forward-binary-汉字')
      expect(await alias.closeForward(forward.id)).toBe(true);expect(alias.listForwards()).toEqual([])
      expect(await canConnect(again.local_port)).toBe(false)
    }finally{await new Promise<void>(r=>echo.close(()=>r()))}
    expect(existsSync(f.dir+'/LOCAL_COMMAND_RAN')).toBe(false);expect(existsSync(f.dir+'/UNOWNED_MASTER')).toBe(false)
    expect(readdirSync(f.home)).toEqual([])
  }finally{await f.close()}
},120000)

test('real SSH fault relay: exec proxy refusal, lost ACK lookup, crash intent no respawn, root replacement',async()=>{
  // Streaming relay in every adapter session: DROP_ACK names the method whose response is lost.
  const f=await loopbackFixture({relay:true})
  try {
    for(const mode of ['PROXY','WRONG_EXIT','NOISY']) {
      writeFileSync(f.dir+'/'+mode,'1')
      try { await expect(f.transport().probe()).rejects.toMatchObject({code:'unsupported_transport'}) }
      finally { unlinkSync(f.dir+'/'+mode) }
    }
    const t=f.transport(), r=await t.openRoot({path:f.project}), lease=await t.request(r,'leases.acquire',{owner_id:'fault-test'},op())
    const jobOp=op(), params={command:"printf 'once\\n' >> lost-ack-count; sleep 0.3; printf 'survived'; exit 19",lease}
    writeFileSync(f.dir+'/DROP_ACK','jobs.start')
    await expect(t.request(r,'jobs.start',params,jobOp)).rejects.toMatchObject({code:'outcome_unknown',operation_id:jobOp})
    const recovered=await t.request(r,'jobs.recover',{operation_id:jobOp})
    expect((await terminal(t,r,recovered.job_id)).exit_code).toBe(19)
    expect(readFileSync(f.project+'/lost-ack-count','utf8')).toBe('once\n')
    const writeOp=op(), write={path:'lost-write',data:data('committed once'),expected_hash:null,lease}
    writeFileSync(f.dir+'/DROP_ACK','files.write')
    await expect(t.request(r,'files.write',write,writeOp)).rejects.toMatchObject({code:'outcome_unknown',operation_id:writeOp})
    // Lost responses are never replayed: each mutation frame crossed the wire exactly once.
    for (const id of [jobOp,writeOp]) expect(f.relayLog().filter(e=>e.event==='request'&&e.operation_id===id)).toHaveLength(1)
    const status=await t.request(r,'operations.status',{operation_id:writeOp})
    expect(status.state).toBe('applied');expect(readFileSync(f.project+'/lost-write','utf8')).toBe('committed once')
    // Crash window: real persisted intent but no supervisor. Same op must NOT start again.
    const pending=op(), jobId=op(), crashParams={command:'touch SHOULD_NOT_RUN',lease}
    // Python json separators in production contain no whitespace; sorted recursively.
    const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v
    const digest=createHash('sha256').update(JSON.stringify(ordered(['jobs.start',crashParams]))).digest('hex')
    writeFileSync(r.state_path+'/operations/'+pending+'.json',JSON.stringify({operation_id:pending,state:'prepared',digest}))
    mkdirSync(r.state_path+'/jobs/'+jobId,{mode:0o700})
    writeFileSync(r.state_path+'/jobs/'+jobId+'/spec.json',JSON.stringify({job_id:jobId,operation_id:pending,timeout_s:null,output_cap_bytes:null,lease}))
    writeFileSync(r.state_path+'/operations/'+pending+'.job',JSON.stringify({job_id:jobId}))
    await expect(t.request(r,'jobs.start',crashParams,pending)).rejects.toMatchObject({code:'outcome_unknown'})
    expect((await t.request(r,'jobs.recover',{operation_id:pending})).state).toBe('unknown')
    expect(existsSync(f.project+'/SHOULD_NOT_RUN')).toBe(false)
    await expect(t.request(r,'leases.release',{lease},op())).rejects.toMatchObject({code:'outcome_unknown'})
    // State redirect cannot create a second root writer lock.
    await expect(t.openRoot({path:f.project,state_path:f.dir+'/another-state'})).rejects.toMatchObject({code:'root_changed'})
    expect(existsSync(f.dir+'/another-state')).toBe(false)
    const scriptPath=r.state_path+'/'+readdirSync(r.state_path).find(name=>name.startsWith('adapter-') && name.endsWith('.py'))!
    const scriptBefore=readFileSync(scriptPath)
    writeFileSync(scriptPath,'raise RuntimeError("corrupted adapter")')
    await expect(t.request(r,'files.stat',{path:'lost-write'})).rejects.toMatchObject({code:'protocol_mismatch'})
    writeFileSync(scriptPath,scriptBefore)
    const metaPath=r.state_path+'/root.json', meta=JSON.parse(readFileSync(metaPath,'utf8'));meta.generation='replaced'
    writeFileSync(metaPath,JSON.stringify(meta))
    await expect(t.request(r,'jobs.status',{job_id:recovered.job_id})).rejects.toMatchObject({code:'root_changed'})
  }finally{await f.close()}
},120000)
