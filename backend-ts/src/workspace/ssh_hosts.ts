/** Saving and connecting SSH hosts on the person's yes. An agent (or a connector's director) names a host; the app
 *  works out what a Connect would do — a saved host reused or a new one saved, a host key the person has never
 *  trusted read from the host — and asks the person once. Their yes trusts that key (into the app's own known_hosts,
 *  never the person's file), saves the host and connects it. Nothing is saved, trusted or dialed before the yes. */

import { execFile } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SshTargetInputSchema, type SshTarget } from '@oasis-code/contract'
import type { Conn } from '../db/database.ts'
import * as targets from '../db/remote_repo.ts'
import { sshArgs } from '../remote/transport.ts'
import type { SshTargetConfig, TransportOptions } from '../remote/types.ts'
import type { RemoteWorkspaceService } from './remote.ts'

export class SshConnectRefused extends Error {
  constructor(message: string) { super(message); this.name = 'SshConnectRefused' }
}

/** A host key the person has not trusted yet, as the host gave it: its known_hosts lines and their fingerprints. */
export interface NewHostKey { lines: string[]; fingerprints: string[] }

export interface HostKeys {
  /** null: the host's key is already in a known_hosts file ssh reads for this host */
  unknownKey(target: SshTargetConfig): Promise<NewHostKey | null>
  trust(key: NewHostKey): void
}

function run(file: string, args: string[], input?: string, timeoutMs = 15_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout) })
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** The host keys as ssh sees them: the host and port it would dial (`ssh -G`, the same options the connection uses),
 *  looked up in the files it would read (`ssh-keygen -F`); an unknown host's keys read with `ssh-keyscan`. */
export function systemHostKeys(options: TransportOptions): HostKeys {
  const ssh = options.ssh_path ?? '/usr/bin/ssh'
  const bin = (name: string) => join(dirname(ssh), name)
  const files = options.known_hosts_file ? [options.known_hosts_file]
    : [join(homedir(), '.ssh', 'known_hosts'), join(homedir(), '.ssh', 'known_hosts2'), ...(options.app_known_hosts_file ? [options.app_known_hosts_file] : [])]
  const trustFile = options.known_hosts_file ?? options.app_known_hosts_file ?? null
  return {
    async unknownKey(target) {
      const resolved = await run(ssh, ['-G', ...sshArgs(target, options), target.destination])
      if (resolved.code !== 0) throw new SshConnectRefused(`ssh could not read this host's settings: ${target.destination}`)
      const field = (name: string) => resolved.stdout.split('\n').find((l) => l.startsWith(`${name} `))?.slice(name.length + 1).trim() ?? ''
      const host = field('hostname'), port = Number(field('port') || '22')
      if (!host) throw new SshConnectRefused(`ssh could not resolve the host of ${target.destination}`)
      const pattern = port === 22 ? host : `[${host}]:${port}`
      for (const file of files) {
        if (existsSync(file) && (await run(bin('ssh-keygen'), ['-F', pattern, '-f', file])).code === 0) return null
      }
      const scanned = await run(bin('ssh-keyscan'), ['-T', '8', '-p', String(port), host], undefined, 20_000)
      const lines = scanned.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      if (!lines.length) throw new SshConnectRefused(`${host}:${port} did not answer with a host key; nothing was saved`)
      const printed = await run(bin('ssh-keygen'), ['-l', '-f', '-'], `${lines.join('\n')}\n`)
      const fingerprints = printed.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && p[1]!.startsWith('SHA256:'))
        .map((p) => `${p[1]}${p.at(-1)?.startsWith('(') ? ` ${p.at(-1)!.slice(1, -1)}` : ''}`)
      return { lines, fingerprints }
    },
    trust(key) {
      if (trustFile === null) throw new SshConnectRefused('No known_hosts file is set for the app')
      mkdirSync(dirname(trustFile), { recursive: true, mode: 0o700 })
      appendFileSync(trustFile, `${key.lines.join('\n')}\n`, { mode: 0o600 })
      chmodSync(trustFile, 0o600)
    },
  }
}

export interface SshConnectInput { target_id?: string | null; destination?: string | null; port?: number | null; identity_file?: string | null; name?: string | null }

/** What a yes does: connect a saved host (target_id), or save this one and connect it; trust its key first when new. */
export interface SshConnectPlan {
  target_id: string | null
  label: string
  destination: string
  port: number | null
  identity_file: string | null
  /** connected already: nothing to ask */
  ready: boolean
  host_key: NewHostKey | null
}

/** The question the person answers: what the yes connects, in a title and a few lines. */
export function askText(plan: SshConnectPlan): { title: string; lines: string[] } {
  const where = `${plan.destination}${plan.port != null ? `:${plan.port}` : ''}`
  const lines = [where]
  if (plan.identity_file) lines.push(`key ${plan.identity_file}`)
  if (plan.host_key) lines.push(...plan.host_key.fingerprints.map((f) => `new host key ${f}`))
  return { title: `${plan.target_id ? 'Reconnect to' : 'Connect to'} ${plan.label}?`, lines }
}

export interface SshAsk {
  id: string
  /** who asked: the connector's client, as its call said */
  from: string
  title: string
  lines: string[]
  status: 'pending' | 'connected' | 'declined' | 'failed'
  target: SshTarget | null
  error: string | null
  created_at: string
}

interface AskEntry { view: SshAsk; plan: SshConnectPlan; key: string; settled: Promise<void>; settle: () => void }

export interface SshHostsDeps {
  conn: Conn
  remote: RemoteWorkspaceService
  /** what the person's Connect does after the connection is up (the route's recovery and polling) */
  afterConnect: (targetId: string) => Promise<void>
}

export class SshHostsService {
  /** a connector's questions, kept while this process runs (a restart drops them: the connector asks again) */
  private readonly asks = new Map<string, AskEntry>()
  constructor(private readonly deps: SshHostsDeps, private readonly hostKeys: HostKeys) {}

  /** What a yes would do for this input; refused (nothing asked) when the input names no host it can reach. */
  async plan(input: SshConnectInput): Promise<SshConnectPlan> {
    let saved: SshTarget | null = null
    if (input.target_id) {
      saved = targets.getTarget(this.deps.conn, input.target_id)
      if (saved === null) throw new SshConnectRefused(`No saved SSH host ${input.target_id}; list_ssh_targets shows the saved ones`)
    } else {
      if (!input.destination) throw new SshConnectRefused('Give destination (user@host) or the target_id of a saved host')
      const checked = SshTargetInputSchema.safeParse({ label: input.name?.trim() || input.destination, destination: input.destination, port: input.port ?? null, identity_file: input.identity_file ?? null })
      if (!checked.success) throw new SshConnectRefused(checked.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '))
      const want = checked.data
      saved = targets.listTargets(this.deps.conn).find((t) => t.destination === want.destination && (t.port ?? null) === (want.port ?? null) && (t.identity_file ?? null) === (want.identity_file ?? null)) ?? null
      if (saved === null) {
        const host_key = await this.hostKeys.unknownKey(want)
        return { target_id: null, label: want.label, destination: want.destination, port: want.port ?? null, identity_file: want.identity_file ?? null, ready: false, host_key }
      }
    }
    const ready = this.deps.remote.isReady(saved.id)
    const host_key = ready ? null : await this.hostKeys.unknownKey(saved)
    return { target_id: saved.id, label: saved.label, destination: saved.destination, port: saved.port ?? null, identity_file: saved.identity_file ?? null, ready, host_key }
  }

  /** The person's yes: the key trusted, the host saved (or the one saved meanwhile reused), connected. */
  async apply(plan: SshConnectPlan): Promise<SshTarget> {
    if (plan.host_key) this.hostKeys.trust(plan.host_key)
    let id = plan.target_id
    if (id === null) {
      const same = targets.listTargets(this.deps.conn).find((t) => t.destination === plan.destination && (t.port ?? null) === plan.port && (t.identity_file ?? null) === plan.identity_file)
      id = same?.id ?? targets.createTarget(this.deps.conn, { label: plan.label, destination: plan.destination, port: plan.port, identity_file: plan.identity_file }).id
    }
    const target = await this.deps.remote.connect(id)
    if (target.state === 'ready') await this.deps.afterConnect(id)
    return this.deps.remote.target(id)
  }

  /** A connector's question, shown to the person in the app; the same question still open is the one returned. */
  ask(plan: SshConnectPlan, from: string): SshAsk {
    const key = JSON.stringify([plan.target_id, plan.destination, plan.port, plan.identity_file])
    for (const entry of this.asks.values()) if (entry.key === key && entry.view.status === 'pending') return entry.view
    let settle!: () => void
    const settled = new Promise<void>((resolve) => { settle = resolve })
    const { title, lines } = askText(plan)
    const view: SshAsk = { id: `sshask_${randomUUID().replaceAll('-', '').slice(0, 12)}`, from, title, lines, status: 'pending', target: null, error: null, created_at: new Date().toISOString() }
    this.asks.set(view.id, { view, plan, key, settled, settle })
    return view
  }

  get(id: string): SshAsk | null { return this.asks.get(id)?.view ?? null }

  pending(): SshAsk[] { return [...this.asks.values()].filter((e) => e.view.status === 'pending').map((e) => e.view) }

  /** The person's answer: a yes connects (its outcome is the question's), a no declines. A question answered already
   *  stands as it was. */
  async answer(id: string, connect: boolean): Promise<SshAsk> {
    const entry = this.asks.get(id)
    if (!entry) throw new SshConnectRefused(`No SSH question ${id}`)
    if (entry.view.status !== 'pending') return entry.view
    if (!connect) {
      entry.view = { ...entry.view, status: 'declined' }
      entry.settle()
      return entry.view
    }
    try {
      const target = await this.apply(entry.plan)
      entry.view = { ...entry.view, status: target.state === 'ready' ? 'connected' : 'failed', target, error: target.state === 'ready' ? null : target.last_error ?? target.state }
    } catch (error) {
      entry.view = { ...entry.view, status: 'failed', error: error instanceof Error ? error.message : String(error) }
    }
    entry.settle()
    return entry.view
  }

  /** The question as it stands once answered, or after ms with it still pending. */
  async wait(id: string, ms: number): Promise<SshAsk> {
    const entry = this.asks.get(id)
    if (!entry) throw new SshConnectRefused(`No SSH question ${id}`)
    if (entry.view.status === 'pending') {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([entry.settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })])
      clearTimeout(timer)
    }
    return entry.view
  }
}
