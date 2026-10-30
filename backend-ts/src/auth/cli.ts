/** Explicit browser/device login (`bun run auth …`); no reading or importing other applications' tokens. */

import { createInterface } from 'node:readline'
import { safeFetch } from '../safe_fetch.ts'
import { CallbackServer, validatedInput, type CallbackResult } from './callback.ts'
import { NativeAuthError } from './errors.ts'
import { CODEX_ORIGINATOR, nativeModel } from './models.ts'
import * as oauthAnthropic from './oauth_anthropic.ts'
import * as oauthAntigravity from './oauth_antigravity.ts'
import * as oauthCodex from './oauth_codex.ts'
import { generatePkce, generateState } from './pkce.ts'
import { credentialStore, PROVIDERS, tokenManager, type CredentialStore, type OAuthCredential } from './store.ts'
import { UsageService } from './usage.ts'
import { exchange } from './web_login.ts'

export const LOGIN_TIMEOUT_MS = 600_000
const USAGE = `usage: bun run auth [--auth-dir DIR] <command>
  login <${PROVIDERS.join('|')}> [--no-browser] [--device | --paste]
  status
  usage
  logout <${PROVIDERS.join('|')}>
  smoke <provider:model>`

const say = (text: string) => { process.stderr.write(`${text}\n`) }

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    rl.once('line', (line) => { rl.close(); resolve(line) })
    rl.once('close', () => resolve(''))
  })
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url]
  try { Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' }) } catch { /* the URL was printed */ }
}

async function browserFlow(provider: string, challenge: string, state: string, opts: { open_browser: boolean; paste: boolean }): Promise<CallbackResult> {
  const module = provider === oauthCodex.PROVIDER ? oauthCodex : provider === 'antigravity' ? oauthAntigravity : oauthAnthropic
  const url = provider === oauthCodex.PROVIDER
    ? oauthCodex.authorizeUrl({ state, challenge, originator: CODEX_ORIGINATOR }) : provider === 'antigravity' ? oauthAntigravity.authorizeUrl({ state, challenge }) : oauthAnthropic.authorizeUrl({ state, challenge })
  let server: CallbackServer | null = null
  try {
    if (!opts.paste) {
      server = new CallbackServer({ host: module.CALLBACK_HOST, port: module.CALLBACK_PORT, path: module.CALLBACK_PATH, expected_state: state })
      try { await server.start() } catch { throw new NativeAuthError('callback port is unavailable; retry with --paste') }
    }
    say(`Open this URL to sign in:\n${url}`)
    if (opts.open_browser) openBrowser(url)
    if (opts.paste || server === null) {
      say('Paste the full redirect URL or code#state:')
      const line = await Promise.race([readLine(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), LOGIN_TIMEOUT_MS))])
      if (provider === 'antigravity') oauthAntigravity.validatePastedRedirect(line, module.REDIRECT_URI)
      return validatedInput(line, state)
    }
    return await server.wait(LOGIN_TIMEOUT_MS)
  } catch (error) {
    if ((error as Error).message === 'timed out') throw new NativeAuthError('login timed out; run login again')
    throw error
  } finally {
    if (server !== null) await server.close()
  }
}

export async function login(store: CredentialStore, provider: string, opts: { device?: boolean; open_browser?: boolean; paste?: boolean } = {}): Promise<OAuthCredential> {
  const http = (input: string | URL, init?: RequestInit) => safeFetch(input, init)
  let grant: OAuthCredential
  if (opts.device) {
    if (provider !== 'openai-codex') throw new NativeAuthError('--device is available only for openai-codex')
    const auth = await oauthCodex.deviceStart(http)
    say(`Open ${oauthCodex.DEVICE_VERIFICATION_URL} and enter: ${auth.user_code}`)
    const [code, verifier] = await oauthCodex.devicePoll(http, auth)
    grant = await oauthCodex.exchangeCode(http, { code, verifier, redirect_uri: oauthCodex.DEVICE_REDIRECT_URI })
  } else {
    const [verifier, challenge] = generatePkce()
    const state = generateState()
    const module = provider === 'openai-codex' ? oauthCodex : provider === 'antigravity' ? oauthAntigravity : oauthAnthropic
    const result = await browserFlow(provider, challenge, state, { open_browser: opts.open_browser ?? true, paste: opts.paste ?? false })
    grant = await exchange(provider, http, result, verifier, module.REDIRECT_URI)
  }
  await store.modify(provider, async () => grant.with({ authorized_at_ms: Date.now() }))
  return grant
}

interface Args { command: string; provider?: string; model?: string; auth_dir: string | null; device: boolean; paste: boolean; no_browser: boolean }

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: '', auth_dir: null, device: false, paste: false, no_browser: false }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--auth-dir') { args.auth_dir = argv[i + 1] ?? null; i += 1 }
    else if (arg.startsWith('--auth-dir=')) args.auth_dir = arg.slice('--auth-dir='.length)
    else if (arg === '--device') args.device = true
    else if (arg === '--paste') args.paste = true
    else if (arg === '--no-browser') args.no_browser = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}\n${USAGE}`)
    else positional.push(arg)
  }
  args.command = positional[0] ?? ''
  if (!['login', 'status', 'usage', 'logout', 'smoke'].includes(args.command)) throw new Error(USAGE)
  if (args.command === 'login' || args.command === 'logout') {
    args.provider = positional[1]
    if (!args.provider || !(PROVIDERS as readonly string[]).includes(args.provider)) throw new Error(`login/logout need a provider: ${PROVIDERS.join(', ')}`)
  }
  if (args.command === 'smoke') {
    args.model = positional[1]
    if (!args.model) throw new Error('smoke needs a model: provider:model, e.g. anthropic:claude-opus-5-5')
  }
  if (args.device && args.paste) throw new Error('--device and --paste exclude each other')
  return args
}

export async function run(args: Args): Promise<number> {
  const store = credentialStore(args.auth_dir)
  if (args.command === 'status') {
    const data = store.list()
    for (const entry of Object.values(data)) {
      entry.status = entry.disabled_reason ? 'login_required' : (entry.expires_ms as number) <= Date.now() + 300_000 ? 'refresh_needed' : 'ready'
    }
    console.log(JSON.stringify(data, null, 2))
  } else if (args.command === 'login') {
    await login(store, args.provider!, { device: args.device, open_browser: !args.no_browser, paste: args.paste })
    say(`Signed in to ${args.provider}.`)
  } else if (args.command === 'logout') {
    const removed = await store.delete(args.provider!)
    say(removed ? 'Local credential removed.' : 'No local credential was stored.')
  } else if (args.command === 'usage') {
    const service = UsageService.fromEnvironment()
    service.manager = tokenManager(args.auth_dir)
    console.log(JSON.stringify(await service.snapshot(), null, 2))
  } else if (args.command === 'smoke') {
    const { modelRequest, userPrompt } = await import('../llm/messages.ts')
    const model = nativeModel(args.model!, tokenManager(args.auth_dir), { maxRetries: 0 })
    try {
      const response = await model.request([modelRequest([userPrompt('Reply with OK.')], 'Reply briefly.')], {}, { function_tools: [], allow_text_output: true, thinking: null })
      console.log(response.parts.filter((p) => p.part_kind === 'text').map((p) => (p as { content: string }).content).join(''))
    } finally {
      await (model as { close?: () => Promise<void> }).close?.()
    }
  }
  return 0
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: Args
  try { args = parseArgs(argv) } catch (error) { say((error as Error).message); return 2 }
  try {
    return await run(args)
  } catch (error) {
    // SDK/network exceptions can contain request metadata; only our errors have messages intended for display
    say(error instanceof NativeAuthError ? error.message : `Login operation failed (${(error as Error).name}).`)
    return 1
  }
}

if (import.meta.main) process.exit(await main())
