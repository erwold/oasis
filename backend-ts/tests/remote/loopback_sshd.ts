/** Real system OpenSSH fixture. No pod, user key/config/agent, launchd, or product ports.
 * Each fixture owns a fresh HOME, host/client keys, config, known_hosts, and recorded child PIDs.
 * HOME/ZDOTDIR are set by sshd BEFORE the account's login shell executes ForceCommand.
 * The dispatcher then starts a clean /bin/sh. This is HOME isolation, not an OS sandbox. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, createConnection } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

export interface CommandResult { code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }
export interface PidRecord { pid: number; command: string; started: string; label: string; ended?: boolean }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const quote = (v: string) => "'" + v.replaceAll("'", "'\\''") + "'"
export function inspectPid(pid: number): { command: string; started: string } | null {
  const r = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.trim()) return null
  const line = r.stdout.trim()
  // ps lstart is fixed five fields: day-of-week, month, day, hh:mm:ss, year.
  const match = /^(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/.exec(line)
  if (!match) throw new Error('cannot parse owned PID identity')
  return { started: match[1]!.replace(/\s+/g, ' '), command: match[2]! }
}
export async function freeLoopbackPort(): Promise<number> {
  for (;;) {
    const server = createServer()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (![8321, 8322, 8323, 8324, 8399].includes(port)) return port
  }
}
export async function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: '127.0.0.1', port })
    s.setTimeout(300)
    const finish = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.once('connect', () => finish(true)); s.once('error', () => finish(false)); s.once('timeout', () => finish(false))
  })
}

export class LoopbackSshd {
  readonly root: string
  readonly home: string
  readonly workspace: string
  readonly configFile: string
  readonly knownHostsFile: string
  readonly clientKey: string
  readonly ledger: PidRecord[] = []
  readonly alias = 'qa-loopback'
  port = 0
  private server?: ChildProcess
  private serverRecord?: PidRecord
  private serverLog = ''
  private children = new Map<ChildProcess, PidRecord>()
  private closed = false
  readonly env: NodeJS.ProcessEnv

  private constructor(parent?: string) {
    this.root = realpathSync(mkdtempSync(join(parent ?? tmpdir(), 'oasis-ssh-fixture-')))
    chmodSync(this.root, 0o700)
    this.home = join(this.root, 'home'); this.workspace = join(this.root, 'workspace')
    for (const d of [this.home, this.workspace, join(this.root, 'tmp')]) mkdirSync(d, { mode: 0o700 })
    this.configFile = join(this.root, 'ssh_config'); this.knownHostsFile = join(this.root, 'known_hosts'); this.clientKey = join(this.root, 'client_key')
    this.env = { HOME: this.home, ZDOTDIR: this.home, TMPDIR: join(this.root, 'tmp'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin', LANG: 'en_US.UTF-8' }
  }

  static async start(options: { parent?: string; allowForwarding?: boolean } = {}): Promise<LoopbackSshd> {
    const f = new LoopbackSshd(options.parent)
    try { await f.startServer(options.allowForwarding !== false); return f }
    catch (e) { await f.close().catch(() => {}); throw e }
  }

  private persist() { writeFileSync(join(this.root, 'pids.json'), JSON.stringify(this.ledger, null, 2) + '\n') }
  private async record(child: ChildProcess, label: string): Promise<PidRecord | null> {
    for (let i = 0; i < 30; i++) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return null
      const identity = inspectPid(child.pid)
      if (identity) {
        const record = { pid: child.pid, ...identity, label }
        this.ledger.push(record); this.children.set(child, record); this.persist(); return record
      }
      await sleep(10)
    }
    throw new Error('unable to record own child PID')
  }

  /** No pattern/group kill. Both recorded PID start time and exact full command must still match. */
  private async stop(child: ChildProcess, rec: PidRecord): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) { rec.ended = true; this.persist(); return }
    const current = inspectPid(rec.pid)
    if (!current) { rec.ended = true; this.persist(); return }
    if (current.command !== rec.command || current.started !== rec.started) throw new Error(`refusing signal: PID identity changed (${rec.label}, ${rec.pid})`)
    child.kill('SIGTERM')
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null || child.signalCode !== null || !inspectPid(rec.pid)) { rec.ended = true; this.persist(); return }; await sleep(20) }
    throw new Error(`own child did not terminate (${rec.label}, ${rec.pid}); no unverified escalation`)
  }

  async run(file: string, args: string[], input = '', timeoutMs = 10_000): Promise<CommandResult> {
    const child = spawn(file, args, { env: this.env, cwd: this.home, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout!.on('data', (b) => { stdout += String(b) }); child.stderr!.on('data', (b) => { stderr += String(b) })
    const completion = new Promise<CommandResult>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, timedOut }))
    })
    child.stdin!.on('error', () => {})
    child.stdin!.end(input)
    const rec = await this.record(child, file)
    const timer = setTimeout(() => { timedOut = true; if (rec) void this.stop(child, rec).catch((e) => { stderr += `\n${String(e)}` }) }, timeoutMs)
    try { return await completion }
    finally { clearTimeout(timer); if (rec) { rec.ended = child.exitCode !== null || child.signalCode !== null; this.persist() }; this.children.delete(child) }
  }

  sshArgs(extra: string[] = []): string[] { return ['-F', this.configFile, ...extra, this.alias] }
  exec(command: string, timeoutMs = 10_000): Promise<CommandResult> { return this.run('/usr/bin/ssh', [...this.sshArgs(), command], '', timeoutMs) }

  private async startServer(allowForwarding: boolean) {
    const keygen = '/usr/bin/ssh-keygen'
    for (const key of [this.clientKey, join(this.root, 'host_key')]) {
      const r = await this.run(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'qa-ephemeral-only', '-f', key])
      if (r.code !== 0) throw new Error(`fixture key generation failed: ${r.stderr}`)
    }
    writeFileSync(join(this.root, 'authorized_keys'), readFileSync(this.clientKey + '.pub'), { mode: 0o600 })
    this.port = await freeLoopbackPort()
    const host = readFileSync(join(this.root, 'host_key.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ')
    writeFileSync(this.knownHostsFile, `[127.0.0.1]:${this.port} ${host}\n`, { mode: 0o600 })
    writeFileSync(this.configFile, `Host ${this.alias}\n  HostName 127.0.0.1\n  User ${userInfo().username}\n  Port ${this.port}\n  IdentityFile ${this.clientKey}\n  IdentityAgent none\n  IdentitiesOnly yes\n  BatchMode yes\n  ConnectTimeout 5\n  ConnectionAttempts 1\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${this.knownHostsFile}\n  GlobalKnownHostsFile /dev/null\n  UpdateHostKeys no\n  ForwardAgent no\n  ServerAliveInterval 2\n  ServerAliveCountMax 2\n`, { mode: 0o600 })
    const dispatch = join(this.root, 'dispatch.sh')
    writeFileSync(dispatch, `#!/bin/sh\ncd ${quote(this.home)} || exit 111\nexec /usr/bin/env -i HOME=${quote(this.home)} ZDOTDIR=${quote(this.home)} TMPDIR=${quote(join(this.root, 'tmp'))} PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin LANG=en_US.UTF-8 /bin/sh -c "\${SSH_ORIGINAL_COMMAND:-exec /bin/sh}"\n`, { mode: 0o700 })
    const sftp = ['/usr/libexec/sftp-server', '/usr/lib/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find(existsSync)
    if (!sftp) throw new Error('system sftp-server not found (not silently replaced with mock)')
    const config = join(this.root, 'sshd_config')
    writeFileSync(config, `ListenAddress 127.0.0.1\nPort ${this.port}\nHostKey ${join(this.root, 'host_key')}\nPidFile ${join(this.root, 'sshd.pid')}\nAuthorizedKeysFile ${join(this.root, 'authorized_keys')}\nAuthenticationMethods publickey\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nPermitUserRC no\nPermitUserEnvironment no\nAllowUsers ${userInfo().username}\nAllowTcpForwarding ${allowForwarding ? 'local' : 'no'}\nGatewayPorts no\nX11Forwarding no\nPermitTTY yes\nSetEnv HOME=${this.home} ZDOTDIR=${this.home} ENV=${join(this.home, 'empty-rc')} BASH_ENV=${join(this.home, 'empty-rc')}\nForceCommand /bin/sh ${dispatch}\nSubsystem sftp ${sftp}\nLogLevel VERBOSE\n`, { mode: 0o600 })
    writeFileSync(join(this.home, 'empty-rc'), '')
    const check = await this.run('/usr/sbin/sshd', ['-t', '-f', config])
    if (check.code !== 0) throw new Error(`sshd configuration refused: ${check.stderr}`)
    await this.listen()
  }

  /** The listener on the fixture's port, host key, config and authorized key (started again after stopListener). */
  private async listen() {
    const args = ['-D', '-e', '-f', join(this.root, 'sshd_config')]
    const server = spawn('/usr/sbin/sshd', args, { env: this.env, cwd: this.home, stdio: ['ignore', 'pipe', 'pipe'] })
    this.server = server
    let log = ''
    server.on('error', (e) => { this.serverLog += String(e) })
    for (const stream of [server.stdout!, server.stderr!]) stream.on('data', (b) => { log += String(b); this.serverLog += String(b); writeFileSync(join(this.root, 'sshd.log'), this.serverLog) })
    for (let i = 0; i < 100; i++) {
      if (log.includes('Server listening on')) break
      if (server.exitCode !== null) throw new Error(`sshd exited: ${this.serverLog}`)
      await sleep(20)
    }
    // sshd rewrites argv. Capture its stable listener title, not the original spawn argv.
    this.serverRecord = (await this.record(server, 'sshd-listener')) ?? undefined
    if (!this.serverRecord || !log.includes('Server listening on')) throw new Error(`sshd failed to listen: ${this.serverLog}`)
  }

  /** The host gone for new connections: only the recorded listener is stopped (exact PID, start time and title, the
   *  title waited for while a connection is starting); nothing answers on the port until startListener. Sessions
   *  already open are their own processes and end with their clients. */
  async stopListener(): Promise<void> {
    const server = this.server, record = this.serverRecord
    if (!server || !record) return
    for (let i = 0; ; i++) {
      try { await this.stop(server, record); break }
      catch (error) { if (i >= 40) throw error; await sleep(50) }
    }
    this.children.delete(server)
    this.server = undefined; this.serverRecord = undefined
  }

  /** The same host back: the same port, keys and configuration. */
  async startListener(): Promise<void> {
    if (this.closed) throw new Error('fixture closed')
    if (this.server && this.server.exitCode === null && this.server.signalCode === null) return
    await this.listen()
  }

  /** Own a tunnel for fixture protocol tests; product tests must use the product forward API instead. */
  async tunnel(remotePort: number): Promise<{ localPort: number; close: () => Promise<void> }> {
    const localPort = await freeLoopbackPort()
    const child = spawn('/usr/bin/ssh', this.sshArgs(['-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`]), { env: this.env, cwd: this.home, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout!.resume(); child.stderr!.resume()
    const rec = await this.record(child, 'fixture-tunnel')
    if (!rec) throw new Error('tunnel exited before ownership recorded')
    for (let i = 0; i < 100; i++) { if (await portListening(localPort)) return { localPort, close: async () => { await this.stop(child, rec); this.children.delete(child) } }; if (child.exitCode !== null) break; await sleep(20) }
    await this.stop(child, rec); this.children.delete(child); throw new Error('fixture tunnel failed to listen')
  }

  async close(options: { keepEvidence?: boolean } = {}): Promise<void> {
    if (this.closed) return
    // Close clients first and allow the listener startup count to settle to the recorded idle title.
    for (const [child, record] of this.children) if (child !== this.server) await this.stop(child, record)
    await sleep(100)
    if (this.server && this.serverRecord) await this.stop(this.server, this.serverRecord)
    this.closed = true
    // Never retain generated private keys even when retaining failed test evidence.
    for (const file of ['client_key', 'host_key']) rmSync(join(this.root, file), { force: true })
    if (!options.keepEvidence) rmSync(this.root, { recursive: true, force: true })
  }
}
