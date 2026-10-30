import {test,expect} from 'bun:test'
import {mkdirSync,writeFileSync,readFileSync,existsSync,statSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {loopbackFixture} from './loopback.fixture.ts'
import {externalStatePython} from './external_state.fixture.ts'
import {fnmatchcase} from '../workspace/paths.ts'
import type {SshTransport} from './transport.ts'
import type {RemoteRoot} from './types.ts'
const old=process.env.REMOTE_POLICY_OLD==='1'
function snapshot(path:string):unknown {
 return readdirSync(path).sort().map(name=>{const p=join(path,name),s=statSync(p);return s.isDirectory()?[name,s.mode,snapshot(p)]:[name,s.mode,s.size,s.mtimeMs,createHash('sha256').update(readFileSync(p)).digest('hex')]})
}
async function guardedWrite(t:SshTransport,root:RemoteRoot,path:string,patterns:string[],value:string){
 // Old branch is the committed main's REAL fnmatchcase policy expression, not a missing-method failure.
 const matched=old?patterns.some(p=>fnmatchcase(path,p)||(p.endsWith('/**')&&path.startsWith(p.slice(0,-3)+'/')))
  :(await t.request(root,'files.policyMatch',{path,patterns,allow_missing:true})).matches.some(Boolean)
 if(matched)return 'refused'
 const actual=await t.request(root,'files.resolve',{path,allow_missing:true})
 let before:string|null=null
 if(actual.exists)before=(await t.request(root,'files.stat',{path:actual.path})).sha256!
 const lease=await t.request(root,'leases.acquire',{owner_id:'policy-test'},randomUUID())
 try{await t.request(root,'files.write',{path:actual.path,expected_hash:before,data:Buffer.from(value).toString('base64'),lease},randomUUID())}
 finally{await t.request(root,'leases.release',{lease},randomUUID())}
 return 'applied'
}

test('R14 actual SSH/filesystem: absent protected secret.txt cannot be created as SECRET.TXT',async()=>{
 const f=await loopbackFixture()
 try{
  writeFileSync(f.project+'/witness.txt','volume witness')
  const folded=existsSync(f.project+'/WITNESS.TXT')&&statSync(f.project+'/WITNESS.TXT').ino===statSync(f.project+'/witness.txt').ino
  console.log('R14_NATIVE_CASE_ALIASES',folded)
  const t=f.transport('loopback-a',{python:externalStatePython(f.dir,f.dir+'/unused-shared',process.env.REMOTE_POLICY_ADAPTER)})
  const r=await t.openRoot({path:f.project,state_path:f.dir+'/private-state'})
  const state=await guardedWrite(t,r,'SECRET.TXT',['secret.txt'],'must remain absent on insensitive volume')
  console.log('R14_POSTCONDITION',JSON.stringify({state,upper_exists:existsSync(f.project+'/SECRET.TXT'),lower_exists:existsSync(f.project+'/secret.txt')}))
  expect(state).toBe(folded?'refused':'applied')
  expect(existsSync(f.project+'/SECRET.TXT')).toBe(!folded)
  expect(existsSync(f.project+'/secret.txt')).toBe(false)
 }finally{await f.close()}
},60000)

test('R15 actual SSH/filesystem: actual Secrets dir is protected by secrets/**',async()=>{
 const f=await loopbackFixture()
 try{
  mkdirSync(f.project+'/Secrets');writeFileSync(f.project+'/Secrets/note.txt','original')
  const folded=existsSync(f.project+'/secrets/note.txt')&&statSync(f.project+'/secrets/note.txt').ino===statSync(f.project+'/Secrets/note.txt').ino
  console.log('R15_NATIVE_CASE_ALIASES',folded)
  const t=f.transport('loopback-a',{python:externalStatePython(f.dir,f.dir+'/unused-shared',process.env.REMOTE_POLICY_ADAPTER)})
  const r=await t.openRoot({path:f.project,state_path:f.dir+'/private-state'})
  const state=await guardedWrite(t,r,'Secrets/note.txt',['secrets/**'],'changed')
  console.log('R15_POSTCONDITION',JSON.stringify({state,unchanged:readFileSync(f.project+'/Secrets/note.txt','utf8')==='original'}))
  expect(state).toBe(folded?'refused':'applied')
  expect(readFileSync(f.project+'/Secrets/note.txt','utf8')).toBe(folded?'original':'changed')
 }finally{await f.close()}
},60000)

test('policy matching is read-only before Ask/Plan and handles real Unicode aliases and globs',async()=>{
 const f=await loopbackFixture()
 try{
  mkdirSync(f.project+'/Sécrets');writeFileSync(f.project+'/Sécrets/note.txt','original')
  mkdirSync(f.project+'/Secrets');writeFileSync(f.project+'/Secrets/note.txt','original')
  const unicodeAlias='Se\u0301crets/note.txt'
  const normalized=existsSync(f.project+'/'+unicodeAlias)&&statSync(f.project+'/'+unicodeAlias).ino===statSync(f.project+'/Sécrets/note.txt').ino
  const caseAlias=existsSync(f.project+'/secrets/note.txt')&&statSync(f.project+'/secrets/note.txt').ino===statSync(f.project+'/Secrets/note.txt').ino
  console.log('POLICY_NATIVE_UNICODE_ALIAS',normalized)
  const t=f.transport('loopback-a',{python:externalStatePython(f.dir,f.dir+'/unused-shared')})
  const r=await t.openRoot({path:f.project,state_path:f.dir+'/private-state'})
  const before=[snapshot(f.project),snapshot(r.state_path),snapshot(f.dir+'/registry'),snapshot(f.home)]
  const unicode=await t.request(r,'files.policyMatch',{path:'Sécrets/note.txt',patterns:['Se\u0301crets/**']})
  expect(unicode.matches).toEqual([normalized])
  const absent=await t.request(r,'files.policyMatch',{path:'SECRET.TXT',patterns:['secret.txt'],allow_missing:true})
  expect(absent.matches).toEqual([caseAlias]);expect(absent.exists).toBe(false)
  const globs=await t.request(r,'files.policyMatch',{path:'Secrets/note.txt',patterns:['*.TXT','secrets/**','Secrets/[Nn]ote.?xt','other/**']})
  expect(globs.matches).toEqual([caseAlias,caseAlias,true,false])
  expect(globs.scopes.every(s=>s.case_sensitive!==null)).toBe(true)
  const classes=await t.request(r,'files.policyMatch',{path:'_token.txt',patterns:['[A-z]*.txt','[Z-a]*.txt','[!A-Z]*.txt']})
  expect(classes.matches).toEqual([true,true,true])
  const negated=await t.request(r,'files.policyMatch',{path:'Atoken.txt',patterns:['[!A-Z]*.txt']})
  expect(negated.matches).toEqual([false])
  if(normalized){
   const missingUnicode=await t.request(r,'files.policyMatch',{path:'e\u0301-new.txt',patterns:['é-new.txt'],allow_missing:true})
   expect(missingUnicode.matches).toEqual([true]);expect(missingUnicode.conservative).toBe(true)
   const unicodeGlob=await t.request(r,'files.policyMatch',{path:'Sécrets/note.txt',patterns:['Se\u0301crets/*.txt']})
   expect(unicodeGlob.matches).toEqual([true]);expect(unicodeGlob.conservative).toBe(true)
  }
  expect([snapshot(f.project),snapshot(r.state_path),snapshot(f.dir+'/registry'),snapshot(f.home)]).toEqual(before)
  expect(existsSync(f.project+'/SECRET.TXT')).toBe(false)
  expect(readFileSync(f.project+'/Sécrets/note.txt','utf8')).toBe('original')
 }finally{await f.close()}
},60000)

test('unknown native capability refuses unproven protected names but empty rules and proven inode matches still work',async()=>{
 const f=await loopbackFixture()
 try{
  mkdirSync(f.project+'/Secrets');writeFileSync(f.project+'/Secrets/note.txt','original')
  const injection=`
_native_policy_scope = policy_scope
def policy_scope(fd, path):
    result = _native_policy_scope(fd, path)
    result.update(case_sensitive=None, unicode='opaque', source='unknown')
    return result
`
  const t=f.transport('loopback-a',{python:externalStatePython(f.dir,f.dir+'/unused-shared',undefined,injection)})
  const r=await t.openRoot({path:f.project,state_path:f.dir+'/private-state'})
  const before=[snapshot(f.project),snapshot(r.state_path),snapshot(f.dir+'/registry')]
  await expect(t.request(r,'files.policyMatch',{path:'SECRET.TXT',patterns:['secret.txt']})).rejects.toMatchObject({code:'policy_semantics_unavailable'})
  await expect(t.request(r,'files.policyMatch',{path:'unknown-name.txt',patterns:['*.KEY']})).rejects.toMatchObject({code:'policy_semantics_unavailable'})
  const noRules=await t.request(r,'files.policyMatch',{path:'ordinary-new.txt',patterns:[]})
  expect(noRules.matches).toEqual([]);expect(noRules.exists).toBe(false)
  const folded=existsSync(f.project+'/secrets/note.txt')&&statSync(f.project+'/secrets/note.txt').ino===statSync(f.project+'/Secrets/note.txt').ino
  expect((await t.request(r,'files.policyMatch',{path:'Secrets/note.txt',patterns:['secrets/**']})).matches).toEqual([folded])
  expect([snapshot(f.project),snapshot(r.state_path),snapshot(f.dir+'/registry')]).toEqual(before)
  expect(await guardedWrite(t,r,'ordinary-new.txt',[],'normal unprotected write')).toBe('applied')
  expect(readFileSync(f.project+'/ordinary-new.txt','utf8')).toBe('normal unprotected write')
  await expect(t.request(r,'files.policyMatch',{path:r.state_path+'/root.json',patterns:[]})).rejects.toMatchObject({code:'path_refused'})
 }finally{await f.close()}
},60000)

test('modeled mixed directory semantics are not flattened; modeled byte-exact names are not normalized',async()=>{
 const f=await loopbackFixture()
 try{
  mkdirSync(f.project+'/Mounted')
  // Capability fault injection is NOT a Linux or actual mount test. Native stat/read/SSH stay real.
  const injection=`
_native_policy_scope = policy_scope
def policy_scope(fd, path):
    result = _native_policy_scope(fd, path)
    if path == 'Mounted': result.update(case_sensitive=True, unicode='byte-exact', source='unknown')
    else: result.update(case_sensitive=False, unicode='opaque', source='unknown')
    return result
`
  const t=f.transport('loopback-a',{python:externalStatePython(f.dir,f.dir+'/unused-shared',undefined,injection)})
  const r=await t.openRoot({path:f.project,state_path:f.dir+'/private-state'})
  const exact=await t.request(r,'files.policyMatch',{path:'Mounted/UPPER.txt',patterns:['Mounted/upper.txt']})
  expect(exact.matches).toEqual([false])
  expect(exact.scopes.map(s=>s.case_sensitive)).toEqual([false,true])
  expect((await t.request(r,'files.policyMatch',{path:'Mounted/e\u0301.txt',patterns:['Mounted/é.txt']})).matches).toEqual([false])
  await expect(t.request(r,'files.policyMatch',{path:'Mounted/new.TXT',patterns:['*.txt']})).rejects.toMatchObject({code:'policy_semantics_unavailable'})
  expect((await t.request(r,'files.policyMatch',{path:'Mounted/new.TXT',patterns:[]})).matches).toEqual([])
  expect(existsSync(f.project+'/Mounted/new.TXT')).toBe(false)
 }finally{await f.close()}
},60000)

test('policy budgets refuse without mutation or partial decisions',async()=>{
 const f=await loopbackFixture()
 try{
  const t=f.transport('loopback-a',{python:externalStatePython(f.dir,f.dir+'/unused-shared')})
  const r=await t.openRoot({path:f.project,state_path:f.dir+'/private-state'})
  const before=[snapshot(f.project),snapshot(r.state_path),snapshot(f.dir+'/registry')]
  await expect(t.request(r,'files.policyMatch',{path:'new.txt',patterns:new Array(257).fill('*')})).rejects.toMatchObject({code:'invalid_argument'})
  await expect(t.request(r,'files.policyMatch',{path:'new.txt',patterns:['bad\0name']})).rejects.toMatchObject({code:'invalid_argument'})
  await expect(t.request(r,'files.policyMatch',{path:'z'.repeat(200)+'.txt',patterns:new Array(256).fill('a'.repeat(200)+'*')})).rejects.toMatchObject({code:'policy_budget_exceeded'})
  expect([snapshot(f.project),snapshot(r.state_path),snapshot(f.dir+'/registry')]).toEqual(before)
 }finally{await f.close()}
},60000)

test.skipIf(process.platform!=='linux')('actual Linux case-sensitive distinct files keep distinct policy identities (QA only off this host)',async()=>{
 const f=await loopbackFixture()
 try{
  writeFileSync(f.project+'/lower.txt','lower');writeFileSync(f.project+'/LOWER.TXT','upper')
  expect(statSync(f.project+'/lower.txt').ino).not.toBe(statSync(f.project+'/LOWER.TXT').ino)
  mkdirSync(f.project+'/secrets');mkdirSync(f.project+'/Secrets');writeFileSync(f.project+'/Secrets/note.txt','upper directory')
  const t=f.transport('loopback-a',{python:externalStatePython(f.dir,f.dir+'/unused-shared')})
  const r=await t.openRoot({path:f.project,state_path:f.dir+'/private-state'})
  expect((await t.request(r,'files.policyMatch',{path:'LOWER.TXT',patterns:['lower.txt']})).matches).toEqual([false])
  expect((await t.request(r,'files.policyMatch',{path:'Secrets/note.txt',patterns:['secrets/**']})).matches).toEqual([false])
  expect(await guardedWrite(t,r,'UPPER-NEW.TXT',[],'distinct new file')).toBe('applied')
  expect(existsSync(f.project+'/upper-new.txt')).toBe(false)
 }finally{await f.close()}
},60000)

test('Ask/Plan policy dispatcher makes zero Python filesystem mutation attempts, not merely an unchanged final snapshot',async()=>{
 const f=await loopbackFixture()
 try{
  mkdirSync(f.project+'/Secrets');writeFileSync(f.project+'/Secrets/note.txt','original')
  const injection=`
_dispatch_before_audit = dispatch
def dispatch(meta, req):
    if req['method'] != 'files.policyMatch': return _dispatch_before_audit(meta, req)
    import builtins, io
    saved = {}
    def blocked(*args, **kwargs): fail('policy_write_attempt', 'Policy attempted a filesystem mutation')
    original_open = os.open
    def read_only_open(path, flags, *args, **kwargs):
        if flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND): blocked()
        return original_open(path, flags, *args, **kwargs)
    original_builtin, original_io = builtins.open, io.open
    def readonly_file(opener):
        def wrapped(file, mode='r', *args, **kwargs):
            if any(c in mode for c in 'wax+'): blocked()
            return opener(file, mode, *args, **kwargs)
        return wrapped
    for name in ('mkdir','makedirs','unlink','remove','rmdir','rename','replace','chmod','fchmod','chown','fchown','utime','link','symlink','truncate','ftruncate','write'):
        if hasattr(os,name): saved[name]=getattr(os,name);setattr(os,name,blocked)
    os.open=read_only_open
    builtins.open,io.open=readonly_file(original_builtin),readonly_file(original_io)
    try:
        result=_dispatch_before_audit(meta,req)
        result['audit_no_write_attempts']=True
        return result
    finally:
        os.open=original_open
        builtins.open,io.open=original_builtin,original_io
        for name,value in saved.items(): setattr(os,name,value)
`
  const t=f.transport('loopback-a',{python:externalStatePython(f.dir,f.dir+'/unused-shared',undefined,injection)})
  const r=await t.openRoot({path:f.project,state_path:f.dir+'/private-state'})
  const first=await t.request(r,'files.policyMatch',{path:'SECRET.TXT',patterns:['secret.txt']})
  const second=await t.request(r,'files.policyMatch',{path:'Secrets/note.txt',patterns:['secrets/**','*.TXT']})
  expect((first as typeof first&{audit_no_write_attempts:boolean}).audit_no_write_attempts).toBe(true)
  expect((second as typeof second&{audit_no_write_attempts:boolean}).audit_no_write_attempts).toBe(true)
  expect(existsSync(f.project+'/SECRET.TXT')).toBe(false)
  expect(readFileSync(f.project+'/Secrets/note.txt','utf8')).toBe('original')
 }finally{await f.close()}
},60000)
