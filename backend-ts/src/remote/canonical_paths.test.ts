import {test,expect} from 'bun:test'
import {mkdirSync,writeFileSync,readFileSync,existsSync,statSync,symlinkSync,linkSync,unlinkSync,realpathSync} from 'node:fs'
import {randomUUID,createHash} from 'node:crypto'
import {loopbackFixture} from './loopback.fixture.ts'
import {externalStatePython} from './external_state.fixture.ts'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')

test('real filesystem/SSH R5: state case, Unicode, symlink and hardlink aliases never become user files',async()=>{
 const f=await loopbackFixture()
 try{
  const python=externalStatePython(f.dir,f.dir+'/not-a-shared-volume',process.env.REMOTE_CANONICAL_BASELINE)
  const t=f.transport('loopback-a',{python}), root=await t.openRoot({path:f.project})
  const alias=f.project+'/.OASIS-REMOTE/root.json'
  const insensitive=existsSync(alias)&&statSync(alias).ino===statSync(root.state_path+'/root.json').ino
  console.log('ACTUAL_VOLUME_CASE_ALIASES',insensitive)
  if(insensitive){
   const denied=await t.request(root,'files.read',{path:'.OASIS-REMOTE/root.json'}).then(()=>false,(error)=>error.code==='path_refused')
   expect(denied,'private alias must be refused; private response contents are deliberately not logged').toBe(true)
   expect((await t.openRoot({path:f.project.toUpperCase()})).root_id).toBe(root.root_id)
   const guard=f.dir+'/guard-root';mkdirSync(guard,{mode:0o700})
   await expect(t.openRoot({path:guard,state_path:realpathSync(f.dir)+'/GUARD-ROOT'})).rejects.toMatchObject({code:'state_path_refused'})
   expect(existsSync(guard+'/root.json')).toBe(false)
   await expect(t.openRoot({path:(f.dir+'/registry').toUpperCase(),state_path:f.dir+'/registry-as-state'})).rejects.toMatchObject({code:'state_path_refused'})
  }else{
   mkdirSync(f.project+'/.OASIS-REMOTE');writeFileSync(f.project+'/.OASIS-REMOTE/ordinary','not private')
   expect(Buffer.from((await t.request(root,'files.read',{path:'.OASIS-REMOTE/ordinary'})).data,'base64').toString()).toBe('not private')
  }
  symlinkSync(root.state_path,f.project+'/linked-state')
  await expect(t.request(root,'files.read',{path:'linked-state/root.json'})).rejects.toMatchObject({code:'path_refused'})
  linkSync(root.state_path+'/root.json',f.project+'/hardlinked-state')
  try{await expect(t.request(root,'files.read',{path:'hardlinked-state'})).rejects.toMatchObject({code:'path_refused'})}
  finally{unlinkSync(f.project+'/hardlinked-state')}
  const second=f.dir+'/second-root';mkdirSync(second,{mode:0o700})
  const privateName='Prívate-state', ext=await t.openRoot({path:second,state_path:second+'/'+privateName})
  const unicodeAliases=[privateName.toUpperCase(),privateName.normalize('NFD'),privateName.normalize('NFC')]
  for(const name of unicodeAliases){
   const candidate=second+'/'+name+'/root.json'
   if(existsSync(candidate)&&statSync(candidate).ino===statSync(ext.state_path+'/root.json').ino)
    await expect(t.request(ext,'files.read',{path:name+'/root.json'})).rejects.toMatchObject({code:'path_refused'})
  }
  expect((await t.request(ext,'files.list',{path:'.'})).entries).toEqual([])
 }finally{await f.close()}
},120000)

test('real filesystem/SSH R6: noncanonical secrets aliases fail closed; resolver returns actual policy spelling',async()=>{
 const f=await loopbackFixture()
 try{
  mkdirSync(f.project+'/secrets');writeFileSync(f.project+'/secrets/note.txt','original')
  const python=externalStatePython(f.dir,f.dir+'/not-a-shared-volume',process.env.REMOTE_CANONICAL_BASELINE)
  const t=f.transport('loopback-a',{python}), root=await t.openRoot({path:f.project})
  const lease=await t.request(root,'leases.acquire',{owner_id:'canonical-test'},randomUUID())
  const insensitive=existsSync(f.project+'/SECRETS/note.txt')&&statSync(f.project+'/SECRETS/note.txt').ino===statSync(f.project+'/secrets/note.txt').ino
  if(insensitive){
   await expect(t.request(root,'files.read',{path:'SECRETS/note.txt'})).rejects.toMatchObject({code:'path_not_canonical'})
   await expect(t.request(root,'files.edit',{path:'SECRETS/note.txt',expected_hash:hash('original'),old_string:'original',new_string:'changed',lease},randomUUID())).rejects.toMatchObject({code:'path_not_canonical'})
   expect(readFileSync(f.project+'/secrets/note.txt','utf8')).toBe('original')
   expect((await t.request(root,'files.resolve',{path:'SECRETS/note.txt'})).path).toBe('secrets/note.txt')
   expect(await t.request(root,'files.resolve',{path:'SECRETS/new.txt',allow_missing:true})).toMatchObject({path:'secrets/new.txt',exists:false})
  }else{
   mkdirSync(f.project+'/SECRETS');writeFileSync(f.project+'/SECRETS/note.txt','distinct upper file')
   expect((await t.request(root,'files.resolve',{path:'SECRETS/note.txt'})).path).toBe('SECRETS/note.txt')
   expect(Buffer.from((await t.request(root,'files.read',{path:'SECRETS/note.txt'})).data,'base64').toString()).toBe('distinct upper file')
  }
  mkdirSync(f.project+'/ACTUAL-UPPER');writeFileSync(f.project+'/ACTUAL-UPPER/note','upper entry')
  expect((await t.request(root,'files.resolve',{path:'ACTUAL-UPPER/note'})).path).toBe('ACTUAL-UPPER/note')
  // Canonical spelling itself remains readable; caller applies its protected-path policy first.
  expect(Buffer.from((await t.request(root,'files.read',{path:'secrets/note.txt'})).data,'base64').toString()).toBe('original')
  await t.request(root,'leases.release',{lease},randomUUID())
 }finally{await f.close()}
},120000)
