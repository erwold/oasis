import {test,expect} from 'bun:test'
import {mkdtempSync,mkdirSync,chmodSync,existsSync,readFileSync,writeFileSync,renameSync,cpSync,symlinkSync,realpathSync,statSync,readdirSync,rmSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {loopbackFixture} from './loopback.fixture.ts'
import {externalStatePython} from './external_state.fixture.ts'
const op=()=>randomUUID()

test('real SSH: shared 0777 project remains file/job root, secure external state and one alias registry',async()=>{
 const f=await loopbackFixture()
 try{
  const shared=f.dir+'/workspace/oasis-ssh-test/project';mkdirSync(shared,{recursive:true});chmodSync(shared,0o777)
  const python=externalStatePython(f.dir,realpathSync(shared),process.env.REMOTE_EXTERNAL_BASELINE)
  const t=f.transport('loopback-a',{python}), alias=f.transport('loopback-b',{python})
  await t.probe();await t.listDirs(shared)
  expect(existsSync(f.dir+'/registry')).toBe(false)
  // The old mature implementation fails HERE: it insists on a 0700 marker under shared.
  const root=await t.openRoot({path:shared,state_path:f.dir+'/secure-state'})
  expect(root.path).toBe(realpathSync(shared));expect(root.state_path).toBe(realpathSync(f.dir+'/secure-state'))
  expect(statSync(root.state_path).mode&0o777).toBe(0o700)
  expect(statSync(shared).mode&0o777).toBe(0o777)
  expect(existsSync(shared+'/.oasis-remote')).toBe(false)
  const a=await alias.openRoot({path:shared,state_path:f.dir+'/secure-state'});expect(a.root_id).toBe(root.root_id)
  const lease=await t.request(root,'leases.acquire',{owner_id:'one'},op())
  await expect(alias.request(a,'leases.acquire',{owner_id:'two'},op())).rejects.toMatchObject({code:'lease_conflict'})
  await expect(alias.openRoot({path:shared,state_path:f.dir+'/state-two'})).rejects.toMatchObject({code:'root_changed'})
  expect(existsSync(f.dir+'/state-two')).toBe(false)
  await expect(alias.openRoot({path:shared})).rejects.toMatchObject({code:'root_changed'})
  const written=await t.request(root,'files.write',{path:'real-project.txt',expected_hash:null,data:Buffer.from('shared-root').toString('base64'),lease},op())
  expect(readFileSync(shared+'/real-project.txt','utf8')).toBe('shared-root')
  expect((await t.request(root,'files.read',{path:'real-project.txt'})).sha256).toBe(written.after_sha256!)
  expect(existsSync(root.state_path+'/real-project.txt')).toBe(false)
  await expect(t.request(root,'files.stat',{path:'missing'})).rejects.toMatchObject({code:'not_found'})
  const job=await t.request(root,'jobs.start',{command:'pwd > cwd-proof; printf durable; sleep 0.2; exit 23',lease},op())
  await t.disconnect()
  let end;for(let i=0;i<40;i++){end=await alias.request(a,'jobs.status',{job_id:job.job_id});if(end.state==='exited')break;await Bun.sleep(100)}
  expect(end!.exit_code).toBe(23);expect(readFileSync(shared+'/cwd-proof','utf8').trim()).toBe(root.path)
  expect(Buffer.from((await alias.request(a,'jobs.read',{job_id:job.job_id,stream:'stdout'})).data,'base64').toString()).toBe('durable')
  const running=JSON.parse(readFileSync(root.state_path+'/jobs/'+job.job_id+'/running.json','utf8'))
  console.log('EXTERNAL_STATE_JOB',JSON.stringify({supervisor_pid:running.supervisor_pid,child_pid:running.pid_identity.pid,job_id:job.job_id,exit_code:end!.exit_code}))
  expect((await alias.request(a,'leases.release',{lease},op())).released).toBe(true)
  await expect(alias.request({...a,generation:'old'},'files.read',{path:'real-project.txt'})).rejects.toMatchObject({code:'root_changed'})
  // Even a byte-for-byte metadata copy into a replacement directory is a different state.
  renameSync(root.state_path,root.state_path+'-old');cpSync(root.state_path+'-old',root.state_path,{recursive:true});chmodSync(root.state_path,0o700)
  await expect(alias.openRoot({path:shared,state_path:root.state_path})).rejects.toMatchObject({code:'root_changed'})
  await expect(alias.request(a,'jobs.recover',{operation_id:job.operation_id})).rejects.toMatchObject({code:'root_changed'})
  rmSync(root.state_path,{recursive:true});renameSync(root.state_path+'-old',root.state_path)
  // Losing registry metadata cannot silently adopt state or release the previous lease namespace.
  const registryMeta=readFileSync(f.dir+'/registry/registry.json');rmSync(f.dir+'/registry/registry.json')
  await expect(alias.openRoot({path:shared,state_path:root.state_path})).rejects.toMatchObject({code:'root_changed'})
  writeFileSync(f.dir+'/registry/registry.json',registryMeta,{mode:0o600})
  chmodSync(root.state_path,0o777)
  await expect(alias.request(a,'files.read',{path:'real-project.txt'})).rejects.toMatchObject({code:'root_changed'})
  chmodSync(root.state_path,0o700)
  renameSync(root.state_path,root.state_path+'-real');symlinkSync(root.state_path+'-real',root.state_path)
  await expect(alias.request(a,'files.read',{path:'real-project.txt'})).rejects.toMatchObject({code:'root_changed'})
  rmSync(root.state_path);renameSync(root.state_path+'-real',root.state_path)
  chmodSync(f.dir+'/registry',0o777)
  await expect(alias.request(a,'files.read',{path:'real-project.txt'})).rejects.toMatchObject({code:'root_changed'})
  chmodSync(f.dir+'/registry',0o700)
  renameSync(root.state_path,root.state_path+'-removed')
  await expect(alias.request(a,'files.read',{path:'real-project.txt'})).rejects.toMatchObject({code:'root_changed'})
  expect(existsSync(root.state_path)).toBe(false)
 }finally{await f.close()}
},120000)

test('external state rejects symlinks, writable state/ancestors and non-user-owned /tmp',async()=>{
 const f=await loopbackFixture()
 try{
  const python=externalStatePython(f.dir,realpathSync(f.project),process.env.REMOTE_EXTERNAL_BASELINE)
  const t=f.transport('loopback-a',{python})
  mkdirSync(f.dir+'/actual',{mode:0o700});symlinkSync(f.dir+'/actual',f.dir+'/state-link')
  await expect(t.openRoot({path:f.project,state_path:f.dir+'/state-link'})).rejects.toMatchObject({code:'state_path_refused'})
  mkdirSync(f.dir+'/unsafe',{mode:0o777});chmodSync(f.dir+'/unsafe',0o777)
  await expect(t.openRoot({path:f.project,state_path:f.dir+'/unsafe'})).rejects.toMatchObject({code:'state_path_refused'})
  await expect(t.openRoot({path:f.project,state_path:f.dir+'/unsafe/child'})).rejects.toMatchObject({code:'state_path_refused'})
  expect(existsSync(f.dir+'/unsafe/child')).toBe(false)
  await expect(t.openRoot({path:f.project,state_path:'/tmp'})).rejects.toMatchObject({code:'state_path_refused'})
  expect(readdirSync(f.home)).toEqual([])
 }finally{await f.close()}
},60000)
