/** The gateway's files, in `<data dir>/gateway/` (0700; every file 0600, written whole through a rename):
 *
 *    config.json        { version: 1, provider, host }       — what the person set up (no secret in it)
 *    secret             the external capability: the path segment of the public URL (32 random bytes, base64url)
 *    cloudflared-token  a Cloudflare named tunnel's token (provider cloudflare)
 *    ngrok-authtoken    the ngrok account's authtoken (provider ngrok)
 *    ngrok.yml          written by the gateway from the authtoken for ngrok's --config (never logged)
 *    status.json        what the running gateway last saw (no URL, no secret)
 *
 *  The external secret is not the director token nor the session token: rotating those inside this Mac leaves the
 *  public URL as it is; replacing this one (a revoke) is the only thing that changes it. */

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIRECTOR_TOOL_SURFACES, type DirectorToolSurface } from '@oasis-code/contract'

export const GATEWAY_DIR = 'gateway'
export const SECRET_FILE = 'secret'
export const CONFIG_FILE = 'config.json'
export const STATUS_FILE = 'status.json'
export const CLOUDFLARED_TOKEN_FILE = 'cloudflared-token'
export const NGROK_AUTHTOKEN_FILE = 'ngrok-authtoken'
export const NGROK_CONFIG_FILE = 'ngrok.yml'
export const DEFAULT_GATEWAY_PORT = 8324

/** The fixed entry of the public URL: `/<secret>/mcp/current`, the newest tool surface — a connector made once keeps
 *  getting the newest tools, never an older surface left behind. */
export const GATEWAY_ALIASES: { readonly current: DirectorToolSurface } = { current: DIRECTOR_TOOL_SURFACES[DIRECTOR_TOOL_SURFACES.length - 1]! }

/** cloudflare: a named tunnel run from its token (its public hostname routed to the gateway in Cloudflare's
 *  dashboard); ngrok: the account's fixed domain; external: a fixed HTTPS hostname some other tunnel the person runs
 *  (Tailscale Funnel --bg, say) brings to the gateway's port — the gateway starts nothing for it. With none set up the
 *  gateway runs a Cloudflare quick tunnel (`quick`, no config file): its name changes whenever the gateway restarts. */
export type Provider = 'cloudflare' | 'ngrok' | 'external'
export const PROVIDERS: readonly Provider[] = ['cloudflare', 'ngrok', 'external']

export interface GatewayConfig { version: 1; provider: Provider; host: string }

export function gatewayDir(dataDir: string): string { return join(dataDir, GATEWAY_DIR) }

/** A file written whole (temporary name, then rename) and private (0600) in a private folder (0700). */
export function writePrivate(path: string, text: string): void {
  const dir = path.slice(0, path.lastIndexOf('/'))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { chmodSync(dir, 0o700) } catch { /* not ours to change */ }
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

function readTrimmed(path: string): string | null {
  try { return existsSync(path) ? readFileSync(path, 'utf8').trim() || null : null } catch { return null }
}

const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.home', '.home.arpa', '.localhost', '.corp', '.intranet', '.private']

/** The public hostname as the person typed it (`host` or `https://host`, nothing more), lowercased; else why not.
 *  No port, path, query, fragment or user name; no IP literal, no single label, no loopback or private name: the
 *  name ChatGPT is given is a public DNS name, and the gateway accepts requests under it and nothing else. */
export function normalizeHost(input: unknown): { host: string | null; why: string | null } {
  if (typeof input !== 'string') return { host: null, why: 'the host is not text' }
  let raw = input.trim()
  if (!raw) return { host: null, why: 'no host given' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL
    try { url = new URL(raw) } catch { return { host: null, why: 'not a valid address' } }
    if (url.protocol !== 'https:') return { host: null, why: 'the address must be https' }
    if (url.username || url.password) return { host: null, why: 'the address may not carry a user name' }
    if (url.port) return { host: null, why: 'the address may not carry a port' }
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash || raw.endsWith('?') || raw.endsWith('#')) return { host: null, why: 'give the hostname only, without a path' }
    raw = url.hostname
  } else if (/[/@:?#\s\\]/.test(raw)) return { host: null, why: 'give the hostname only (no port, path or user name)' }
  const host = raw.toLowerCase().replace(/\.$/, '')
  if (host.length > 253) return { host: null, why: 'the hostname is too long' }
  const labels = host.split('.')
  if (labels.length < 2) return { host: null, why: 'the hostname must be a public DNS name' }
  for (const label of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return { host: null, why: 'the hostname has an invalid label' }
  if (/^\d+$/.test(labels[labels.length - 1]!)) return { host: null, why: 'an IP address is not accepted: give the tunnel\'s hostname' }
  if (!/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]{2,}$/.test(labels[labels.length - 1]!)) return { host: null, why: 'the hostname must end in a public top-level domain' }
  if (host === 'localhost' || PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return { host: null, why: 'a local or private name is not reachable from ChatGPT' }
  if (host.endsWith('.trycloudflare.com')) return { host: null, why: 'a quick tunnel\'s name changes whenever it starts again: choose the quick tunnel instead of typing its name' }
  return { host, why: null }
}

/** The config as stored, checked: null when there is none or it does not hold up (the gateway then needs setup). */
export function readConfig(dataDir: string): GatewayConfig | null {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(join(gatewayDir(dataDir), CONFIG_FILE), 'utf8')) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!PROVIDERS.includes(r.provider as Provider)) return null
  const { host } = normalizeHost(r.host)
  if (!host) return null
  return { version: 1, provider: r.provider as Provider, host }
}

export function writeConfig(dataDir: string, config: { provider: Provider; host: string }): GatewayConfig {
  if (!PROVIDERS.includes(config.provider)) throw new Error(`unknown provider ${String(config.provider)}`)
  const { host, why } = normalizeHost(config.host)
  if (!host) throw new Error(why ?? 'invalid host')
  const out: GatewayConfig = { version: 1, provider: config.provider, host }
  writePrivate(join(gatewayDir(dataDir), CONFIG_FILE), `${JSON.stringify(out, null, 2)}\n`)
  return out
}

const SECRET_SHAPE = /^[A-Za-z0-9_-]{32,128}$/

/** The external secret, read fresh (a revoke replaces the file while the gateway runs); null when there is none. */
export function readSecret(dataDir: string): string | null {
  const s = readTrimmed(join(gatewayDir(dataDir), SECRET_FILE))
  return s && SECRET_SHAPE.test(s) ? s : null
}

/** The secret there is, else a new one (minted once; the URL stays the same from then on). */
export function ensureSecret(dataDir: string): string {
  return readSecret(dataDir) ?? rotateSecret(dataDir)
}

/** A new external secret: the old public URL stops answering (404) at once. */
export function rotateSecret(dataDir: string): string {
  const secret = randomBytes(32).toString('base64url')
  writePrivate(join(gatewayDir(dataDir), SECRET_FILE), secret)
  return secret
}

export function providerTokenPath(dataDir: string, provider: Exclude<Provider, 'external'>): string {
  return join(gatewayDir(dataDir), provider === 'cloudflare' ? CLOUDFLARED_TOKEN_FILE : NGROK_AUTHTOKEN_FILE)
}

export function readProviderToken(dataDir: string, provider: Provider): string | null {
  if (provider === 'external') return null
  return readTrimmed(providerTokenPath(dataDir, provider))
}

const TOKEN_SHAPE = /^[A-Za-z0-9_+/=.-]{20,4096}$/

/** The token, trimmed, when it has a token's shape; else throws (nothing written). */
export function checkProviderToken(token: string): string {
  const t = String(token).trim()
  if (!TOKEN_SHAPE.test(t)) throw new Error('the token does not look like one (letters, digits and - _ . + / = only)')
  return t
}

/** A provider token kept for the gateway (0600); never echoed back, never put in a command line or an environment. */
export function writeProviderToken(dataDir: string, provider: Provider, token: string): void {
  if (provider === 'external') throw new Error('an external tunnel takes no token here')
  writePrivate(providerTokenPath(dataDir, provider), checkProviderToken(token))
}

export function removeFile(path: string): void { try { unlinkSync(path) } catch { /* none */ } }

/** The session token of this data directory's backend, read fresh on every request: a backend that restarted (or
 *  minted a new one) is reached again without restarting the gateway; null while there is none. */
export function readSessionToken(dataDir: string, env: Record<string, string | undefined> = process.env): string | null {
  if (env.OASIS_CODE_SESSION_TOKEN) return env.OASIS_CODE_SESSION_TOKEN
  return readTrimmed(join(dataDir, 'session-token'))
}

/** What the gateway says about itself, for the app on this Mac (status.json, 0600): no URL, no secret, no token. */
export interface GatewayStatus {
  pid: number
  instance: string
  started_at: string
  updated_at: string
  port: number
  provider: Provider | 'quick'
  host: string | null
  /** starting: the tunnel is coming up; connected: the public name
   *  answered as this gateway; unavailable: the tunnel or the public name does not (the error says what) */
  public: 'starting' | 'connected' | 'unavailable'
  public_checked_at: string | null
  backend: 'up' | 'down' | 'unknown'
  backend_checked_at: string | null
  error: string | null
  /** the code this gateway runs (sourceFingerprint): the app restarts its own job when the code on disk differs */
  build: string
}

export function writeStatus(dataDir: string, status: GatewayStatus): void {
  writePrivate(join(gatewayDir(dataDir), STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`)
}

export function readStatus(dataDir: string): GatewayStatus | null {
  try { return JSON.parse(readFileSync(join(gatewayDir(dataDir), STATUS_FILE), 'utf8')) as GatewayStatus } catch { return null }
}
