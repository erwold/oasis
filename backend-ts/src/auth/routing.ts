/** Which credential a model route runs on. A route's `auth` field decides: `oauth` signs with the subscription
 *  grant of the route's provider (openai -> the Codex sign-in, anthropic -> the Claude sign-in); `api_key` reads
 *  the variable the route names, a key saved on the Accounts page under that name winning over the shell's. The
 *  catalogue reports the state of each; nothing here widens what a run may do. */

import type { ModelConfig } from '../config.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BRIDGE_TOKEN_FILE, CHATGPT_WEB_ID } from '../llm/chatgpt_web.ts'
import { NativeAuthError } from './errors.ts'
import * as keys from './keys.ts'
import { PROVIDER_FOR_PREFIX, credentialStore, defaultAuthDir } from './store.ts'

export interface CredentialState {
  status: 'available' | 'unavailable'
  source: 'oauth' | 'stored' | 'env' | null
  account: string
  account_label: string | null
  hint: string | null
}

/** ChatGPT on the web runs on the page the desktop app holds: here once the app has kept its bridge's token in the
 *  data directory (it started the bridge on this machine); the page's own sign-in is known only to the page, and a
 *  run that finds it signed out says so. */
export const CHATGPT_WEB_ACCOUNT = 'chatgpt-web'

/** The Accounts-page row that gates this route. */
export function accountFor(cfg: ModelConfig): string {
  if (cfg.id === CHATGPT_WEB_ID) return CHATGPT_WEB_ACCOUNT
  if (cfg.auth === 'oauth') return PROVIDER_FOR_PREFIX[cfg.provider]!
  const provider = keys.providerForEnv(cfg.key_env)
  return provider ?? `env:${cfg.key_env}`
}

export function credentialState(cfg: ModelConfig): CredentialState {
  const account = accountFor(cfg)
  if (cfg.id === CHATGPT_WEB_ID) {
    return existsSync(join(defaultAuthDir(), BRIDGE_TOKEN_FILE))
      ? { status: 'available', source: null, account, account_label: "the desktop app's ChatGPT page", hint: null }
      : { status: 'unavailable', source: null, account, account_label: null, hint: 'open ChatGPT in the oasis-code desktop app' }
  }
  if (cfg.auth === 'oauth') {
    let grant
    try {
      grant = credentialStore().read(account)
    } catch (error) {
      if (error instanceof NativeAuthError) return { status: 'unavailable', source: null, account, account_label: null, hint: error.message }
      throw error
    }
    if (grant === null) return { status: 'unavailable', source: null, account, account_label: null, hint: 'sign in' }
    if (grant.disabled_reason) {
      return { status: 'unavailable', source: 'oauth', account, account_label: grant.email || grant.account_id, hint: 'sign in again' }
    }
    return { status: 'available', source: 'oauth', account, account_label: grant.email || grant.account_id, hint: null }
  }
  const [key, source] = keys.keyForEnv(cfg.key_env)
  if (key) return { status: 'available', source, account, account_label: null, hint: null }
  return { status: 'unavailable', source: null, account, account_label: null, hint: `no key (${cfg.key_env})` }
}

export function hasModelAuth(cfg: ModelConfig): boolean {
  return credentialState(cfg).status === 'available'
}
