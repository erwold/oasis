/** Real system sshd; isolated fixture keys/config/HOME. Never uses the person's ~/.ssh. */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, existsSync, appendFileSync, rmSync } from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import { SshTransport } from './transport.ts'
import { externalStatePython } from './external_state.fixture.ts'
import type { SshTargetConfig, TransportOptions } from './types.ts'
const exec = promisify(execFile)
export async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r,j) => { server.once('error',j); server.listen(0,'127.0.0.1',r) })
  const port = (server.address() as {port:number}).port
  await new Promise<void>(r => server.close(() => r()))
  if ([8321,8322,8323,8324,8399].includes(port)) return unusedPort()
  return port
}
/** Streaming session relay (fixture option `relay`): transparent for every adapter session, it logs
 * each request frame (method, operation_id) to relay.log. If DROP_ACK names a method, the FIRST
 * response to that method is withheld and the session closes (lost response after the remote ran
 * it). While HOLD names a method, that response is delayed (FIFO) until HOLD is removed. Works for
 * per-request and persistent channels: nothing waits for EOF. */
const RELAY = String.raw`import collections, json, os, struct, subprocess, sys, threading, time
base = sys.argv[1]
child = subprocess.Popen(['/bin/sh', '-c', os.environ.get('SSH_ORIGINAL_COMMAND', '')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
pending, lock = collections.deque(), threading.Lock()
def log(event, **fields):
    with open(os.path.join(base, 'relay.log'), 'a') as f:
        f.write(json.dumps(dict(event=event, relay_pid=os.getpid(), at=time.time(), **fields)) + '\n')
def marker(name):
    try:
        with open(os.path.join(base, name)) as f:
            return f.read().strip()
    except FileNotFoundError:
        return None
def write_all(fd, data):
    view = memoryview(data)
    while view:
        view = view[os.write(fd, view):]
def requests():
    buf, source_left = b'', None
    try:
        while True:
            chunk = os.read(0, 65536)
            if not chunk:
                break
            buf += chunk
            while True:
                if source_left is None:
                    nl = buf.find(b'\n')
                    if nl < 0:
                        break
                    source_left, buf = int(buf[:nl]), buf[nl + 1:]
                if source_left:
                    take = min(source_left, len(buf))
                    source_left, buf = source_left - take, buf[take:]
                    if source_left:
                        break
                if len(buf) < 8:
                    break
                size = struct.unpack('>I', buf[4:8])[0]
                if len(buf) < 8 + size:
                    break
                req, buf = json.loads(buf[8:8 + size]), buf[8 + size:]
                with lock:
                    pending.append((req.get('method'), req.get('operation_id')))
                log('request', method=req.get('method'), operation_id=req.get('operation_id'))
            child.stdin.write(chunk)
            child.stdin.flush()
    except (OSError, ValueError):
        pass
    try:
        child.stdin.close()
    except OSError:
        pass
threading.Thread(target=requests, daemon=True).start()
out = b''
while True:
    chunk = os.read(child.stdout.fileno(), 65536)
    if not chunk:
        break
    out += chunk
    while len(out) >= 8 and out[:4] == b'OSR1':
        size = struct.unpack('>I', out[4:8])[0]
        if len(out) < 8 + size:
            break
        frame, out = out[:8 + size], out[8 + size:]
        with lock:
            method, op = pending.popleft() if pending else (None, None)
        while method and marker('HOLD') == method:
            time.sleep(0.02)
        if method and marker('DROP_ACK') == method:
            os.unlink(os.path.join(base, 'DROP_ACK'))
            log('dropped', method=method, operation_id=op)
            os._exit(0)
        write_all(1, frame)
    if out and not b'OSR1'.startswith(out[:4]):
        write_all(1, out)
        out = b''
sys.exit(child.wait())
`
export interface FixtureOptions { relay?: boolean }
export async function loopbackFixture(options: FixtureOptions = {}) {
  const dir = mkdtempSync('/tmp/oasis-transport-'), home=dir+'/home', project=dir+'/project'
  mkdirSync(home,{mode:0o700}); mkdirSync(project,{mode:0o700})
  for (const key of ['host','client']) await exec('/usr/bin/ssh-keygen',['-q','-t','ed25519','-N','','-f',dir+'/'+key])
  writeFileSync(dir+'/authorized_keys',readFileSync(dir+'/client.pub'),{mode:0o600})
  const port=await unusedPort(), localExtra=await unusedPort(), remoteExtra=await unusedPort(), dynamicExtra=await unusedPort()
  const hostKey=readFileSync(dir+'/host.pub','utf8')
  writeFileSync(dir+'/known_hosts',`[127.0.0.1]:${port} ${hostKey}`,{mode:0o600})
  writeFileSync(dir+'/empty_known_hosts','',{mode:0o600})
  writeFileSync(dir+'/fault-relay.py',RELAY,{mode:0o600})
  if (options.relay) writeFileSync(dir+'/RELAY','1')
  // sessions.log: one line per SSH exec session, by kind. The transport's challenge and each adapter
  // bootstrap are distinguishable; per-RPC sessions vs one persistent channel are directly counted.
  writeFileSync(dir+'/dispatch.sh',`#!/bin/sh\nexport HOME='${home}'\nexport PATH=/usr/bin:/bin:/usr/sbin:/sbin\nunset ZDOTDIR ENV BASH_ENV\ncd "$HOME" || exit 1\ncase "$SSH_ORIGINAL_COMMAND" in *oasis-ssh-adapter*) kind=adapter;; *'sys.exit(17)'*) kind=challenge;; *) kind=other;; esac\nprintf '%s\\n' "$kind" >> '${dir}/sessions.log'\nif test -f '${dir}/PROXY'; then cat >/dev/null; exit 0; fi\nif test -f '${dir}/WRONG_EXIT'; then /bin/sh -c "$SSH_ORIGINAL_COMMAND"; exit 0; fi\nif test -f '${dir}/NOISY'; then printf 'unexpected banner\\n'; fi\nif test "$kind" = adapter && test -f '${dir}/RELAY'; then exec /usr/bin/python3 -B -I '${dir}/fault-relay.py' '${dir}'; fi\nexec /bin/sh -c "$SSH_ORIGINAL_COMMAND"\n`,{mode:0o700})
  const config=`ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${dir}/host\nPidFile ${dir}/sshd.pid\nAuthorizedKeysFile ${dir}/authorized_keys\nAuthenticationMethods publickey\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPermitUserRC no\nPermitUserEnvironment no\nAllowUsers ${userInfo().username}\nAllowTcpForwarding yes\nGatewayPorts no\nX11Forwarding no\nPermitTTY no\nForceCommand /bin/sh ${dir}/dispatch.sh\nLogLevel ERROR\nMaxStartups 100:30:200\n`
  writeFileSync(dir+'/sshd_config',config,{mode:0o600})
  // All of these user-config side effects MUST be neutralized by the transport's argv.
  writeFileSync(dir+'/ssh_config',`Host loopback-a loopback-b\n HostName 127.0.0.1\n User ${userInfo().username}\n Port ${port}\n LocalForward 127.0.0.1:${localExtra} 127.0.0.1:9\n RemoteForward 127.0.0.1:${remoteExtra} 127.0.0.1:9\n DynamicForward 127.0.0.1:${dynamicExtra}\n PermitLocalCommand yes\n LocalCommand touch ${dir}/LOCAL_COMMAND_RAN\n ForwardAgent yes\n ForwardX11 yes\n UpdateHostKeys yes\n StdinNull yes\n RemoteCommand echo WRONG_COMMAND\n RequestTTY force\n ControlMaster auto\n ControlPath ${dir}/UNOWNED_MASTER\n ControlPersist yes\n ForkAfterAuthentication yes\n`,{mode:0o600})
  await exec('/usr/sbin/sshd',['-t','-f',dir+'/sshd_config'])
  const args=['-D','-e','-f',dir+'/sshd_config'], log=openSync(dir+'/sshd.log','a',0o600)
  const child=spawn('/usr/sbin/sshd',args,{stdio:['ignore',log,log],env:{HOME:home,PATH:'/usr/bin:/bin:/usr/sbin:/sbin'}})
  closeSync(log)
  const command=['/usr/sbin/sshd',...args].join(' ')
  const ledger={start_utc:new Date().toISOString(),pid:child.pid,port,command,dir,localExtra,remoteExtra,dynamicExtra}
  writeFileSync(dir+'/ledger.json',JSON.stringify(ledger,null,2))
  console.log('OWNED_SSHD',JSON.stringify(ledger))
  // Ready when the owned listener says so: sshd writes its PidFile only after its listen sockets are bound (sshd.c,
  // after server_listen()), so the file holding THIS child's pid means our sshd, not another process, listens on the
  // port. Until then the child is watched as before; past 250 ms without it the fixture goes on exactly as the fixed
  // 250 ms wait did (alive: continue; exited: the same error) — the gate only ever shortens that wait, never adds one.
  for (const started=Date.now(); Date.now()-started<250 && child.exitCode===null; await new Promise(r=>setTimeout(r,5))) {
    const written=existsSync(dir+'/sshd.pid')?readFileSync(dir+'/sshd.pid','utf8').trim():''
    if (written===String(child.pid)) break
  }
  if (child.exitCode!==null) throw new Error('Owned sshd exited; inspect fixture sshd.log')
  // Isolate the fixed per-user registry as well as HOME/config/keys. The unused
  // shared path does not alter real filesystem permissions or case semantics.
  const python=externalStatePython(dir,dir+'/unused-shared')
  const transports:SshTransport[]=[]
  const transport=(alias='loopback-a',extra:TransportOptions={},target:Partial<SshTargetConfig>={}) => {
    const t=new SshTransport({destination:alias,identity_file:dir+'/client',...target},{config_file:dir+'/ssh_config',known_hosts_file:dir+'/known_hosts',rpc_timeout_ms:10000,python,...extra})
    transports.push(t); return t
  }
  const lines=(name:string)=>existsSync(dir+'/'+name)?readFileSync(dir+'/'+name,'utf8').split('\n').filter(Boolean):[]
  /** SSH exec sessions accepted by the owned sshd, by kind (adapter bootstrap vs exec challenge). */
  const sessions=()=>{ const all=lines('sessions.log'); return {adapter:all.filter(k=>k==='adapter').length,challenge:all.filter(k=>k==='challenge').length,total:all.length} }
  const relayLog=()=>lines('relay.log').map(l=>JSON.parse(l) as {event:string;method:string;operation_id:string;relay_pid:number})
  const adapterPids=()=>lines('adapter-pids.log').map(Number)
  /** Trust the same fixture host key on another loopback port (fault proxy in front of sshd). */
  const trustPort=(other:number)=>appendFileSync(dir+'/known_hosts',`[127.0.0.1]:${other} ${hostKey}`)
  return {dir,home,project,port,localExtra,remoteExtra,dynamicExtra,python,transport,sessions,relayLog,adapterPids,trustPort,async close(){
    // Release any relay still holding an answer (a failed assertion must not leave a looping fixture process).
    for (const marker of ['HOLD','DROP_ACK']) rmSync(dir+'/'+marker,{force:true})
    await Promise.all(transports.map(t=>t.disconnect()))
    if (child.exitCode===null && child.pid) {
      const actual=(await exec('/bin/ps',['-p',String(child.pid),'-o','command='])).stdout.trim()
      if (actual!==command && !actual.startsWith(`sshd: ${command} [listener]`)) throw new Error('Refusing cleanup: owned sshd command identity differs: '+actual)
      child.kill('SIGTERM')
      await new Promise<void>(r=>child.once('close',()=>r()))
    }
    writeFileSync(dir+'/cleanup.json',JSON.stringify({end_utc:new Date().toISOString(),pid:child.pid,exit_code:child.exitCode,signal:child.signalCode,resources:'own sshd and own transport children closed; temp evidence retained'}))
    console.log('CLEANUP_SSHD',child.pid,child.exitCode,child.signalCode)
  }}
}
