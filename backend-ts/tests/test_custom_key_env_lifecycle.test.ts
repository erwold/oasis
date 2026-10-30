/** The life of a custom key's environment variable: the process carries exactly the variables its current store's
 *  custom keys own — a renamed or forgotten provider leaves no old variable behind, two providers never share one,
 *  a switch of the auth store withdraws the previous store's, and the shell's own variables are never overwritten or
 *  removed. Provider ids are matched as own names only: an inherited property name (constructor, toString) is no
 *  built-in provider. Every key here is synthetic. */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import * as keys from '../src/auth/keys.ts'
import { credentialStore, setDefaultAuthDir } from '../src/auth/store.ts'
import { LoginManager } from '../src/auth/web_login.ts'
import { privateAuthDir } from './helpers.ts'

const OLD = 'OASIS_AUDIT_CUSTOM_OLD'
const NEW = 'OASIS_AUDIT_CUSTOM_NEW'
const SHARED = 'OASIS_AUDIT_CUSTOM_SHARED'
const OTHER = 'OASIS_AUDIT_CUSTOM_OTHER'
const FOURTH = 'OASIS_AUDIT_CUSTOM_FOURTH'
const NAMES = [OLD, NEW, SHARED, OTHER, FOURTH]
const KEY1 = 'synthetic-audit-key-not-real-1234'
const KEY2 = 'synthetic-audit-key-not-real-5678'
const KEY3 = 'synthetic-audit-key-not-real-9012'

let auth: ReturnType<typeof privateAuthDir>
beforeEach(() => { for (const n of NAMES) delete process.env[n]; auth = privateAuthDir() })
afterEach(() => { auth.done(); for (const n of NAMES) delete process.env[n] })

const has = (name: string): boolean => Object.hasOwn(process.env, name)

test('renaming a custom provider\'s env drops the old variable; forgetting it drops the new one', async () => {
  await keys.saveKey('audit-custom', KEY1, { label: 'Audit', env: OLD })
  expect(process.env[OLD]).toBe(KEY1)
  await keys.saveKey('audit-custom', KEY1, { env: NEW })
  expect(has(OLD)).toBe(false)
  expect(keys.keyForEnv(OLD)).toEqual([null, null])
  expect(process.env[NEW]).toBe(KEY1)
  expect(keys.keyForEnv(NEW)).toEqual([KEY1, 'stored'])
  expect(keys.harnessExportedKeyNames()).toEqual([NEW])
  expect(await keys.forgetKey('audit-custom')).toBe(true)
  expect(has(OLD)).toBe(false)
  expect(has(NEW)).toBe(false)
  expect(keys.keyForEnv(OLD)).toEqual([null, null])
  expect(keys.keyForEnv(NEW)).toEqual([null, null])
  expect(keys.harnessExportedKeyNames()).toEqual([])
})

test('a shell variable under the old or the new name is neither overwritten nor removed', async () => {
  process.env[OLD] = 'from-the-shell-old-0001'
  process.env[NEW] = 'from-the-shell-new-0002'
  await keys.saveKey('audit-custom', KEY1, { label: 'Audit', env: OLD })
  expect(process.env[OLD]).toBe('from-the-shell-old-0001')
  expect(keys.keyForEnv(OLD)).toEqual([KEY1, 'stored'])
  await keys.saveKey('audit-custom', KEY1, { env: NEW })
  // the old name is the shell's again; the new one is the shell's too, the stored key still wins for its route
  expect(process.env[OLD]).toBe('from-the-shell-old-0001')
  expect(keys.keyForEnv(OLD)).toEqual(['from-the-shell-old-0001', 'env'])
  expect(process.env[NEW]).toBe('from-the-shell-new-0002')
  expect(keys.keyForEnv(NEW)).toEqual([KEY1, 'stored'])
  expect(keys.harnessExportedKeyNames()).toEqual([])
  await keys.forgetKey('audit-custom')
  expect(process.env[OLD]).toBe('from-the-shell-old-0001')
  expect(process.env[NEW]).toBe('from-the-shell-new-0002')
  expect(keys.keyForEnv(NEW)).toEqual(['from-the-shell-new-0002', 'env'])
})

test('two custom providers cannot share an env name, by save or by rename', async () => {
  await keys.saveKey('audit-one', KEY1, { label: 'One', env: SHARED })
  await expect(keys.saveKey('audit-two', KEY2, { label: 'Two', env: SHARED })).rejects.toThrow(`${SHARED} is already the env of`)
  expect(keys.customProviders()).toEqual({ 'audit-one': { label: 'One', env: SHARED } })
  await keys.saveKey('audit-two', KEY2, { label: 'Two', env: OTHER })
  await expect(keys.saveKey('audit-two', KEY2, { env: SHARED })).rejects.toThrow(`${SHARED} is already the env of`)
  expect(process.env[SHARED]).toBe(KEY1)
  expect(process.env[OTHER]).toBe(KEY2)
  // the same provider saving again under its own env is no conflict
  await keys.saveKey('audit-one', KEY3)
  expect(process.env[SHARED]).toBe(KEY3)
  // forgetting one never takes the other's variable
  await keys.forgetKey('audit-two')
  expect(has(OTHER)).toBe(false)
  expect(process.env[SHARED]).toBe(KEY3)
})

test('concurrent saves of two providers under one env: exactly one wins, and the variable holds its key', async () => {
  const results = await Promise.allSettled([
    keys.saveKey('audit-one', KEY1, { label: 'One', env: SHARED }),
    keys.saveKey('audit-two', KEY2, { label: 'Two', env: SHARED }),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const custom = keys.customProviders()
  expect(Object.keys(custom)).toHaveLength(1)
  const winner = Object.keys(custom)[0]!
  expect(process.env[SHARED]).toBe(winner === 'audit-one' ? KEY1 : KEY2)
  expect(keys.keyForEnv(SHARED)).toEqual([process.env[SHARED]!, 'stored'])
})

test('concurrent saves, renames and forgets converge on the store\'s final state', async () => {
  await keys.saveKey('audit-one', KEY1, { label: 'One', env: OLD })
  await keys.saveKey('audit-two', KEY2, { label: 'Two', env: OTHER })
  await Promise.all([
    keys.saveKey('audit-one', KEY1, { env: NEW }),
    keys.forgetKey('audit-two'),
    keys.saveKey('audit-three', KEY3, { label: 'Three', env: FOURTH }),
  ])
  expect(has(OLD)).toBe(false)
  expect(has(OTHER)).toBe(false)
  expect(process.env[NEW]).toBe(KEY1)
  expect(process.env[FOURTH]).toBe(KEY3)
  expect(keys.harnessExportedKeyNames().sort()).toEqual([FOURTH, NEW].sort())
  expect(keys.keyForEnv(OLD)).toEqual([null, null])
  expect(keys.keyForEnv(OTHER)).toEqual([null, null])
})

test('a store that already holds two providers on one env exports the one the routes read, then hands it over', async () => {
  const store = credentialStore()
  mkdirSync(dirname(store.path), { recursive: true, mode: 0o700 })
  writeFileSync(store.path, JSON.stringify({
    'audit-a': { type: 'api_key', key: KEY1, label: 'A', env: SHARED },
    'audit-b': { type: 'api_key', key: KEY2, label: 'B', env: SHARED },
  }), { mode: 0o600 })
  keys.exportEnvironment()
  expect(keys.providerForEnv(SHARED)).toBe('audit-a')
  expect(process.env[SHARED]).toBe(KEY1)
  expect(keys.keyForEnv(SHARED)).toEqual([KEY1, 'stored'])
  await keys.forgetKey('audit-a')
  expect(keys.providerForEnv(SHARED)).toBe('audit-b')
  expect(process.env[SHARED]).toBe(KEY2)
  await keys.forgetKey('audit-b')
  expect(has(SHARED)).toBe(false)
})

test('switching the auth store withdraws the previous store\'s exported variables', async () => {
  await keys.saveKey('audit-custom', KEY1, { label: 'Audit', env: OLD })
  expect(process.env[OLD]).toBe(KEY1)
  const second = join(auth.dir, 'second')
  setDefaultAuthDir(second)
  expect(has(OLD)).toBe(false)
  expect(keys.harnessExportedKeyNames()).toEqual([])
  expect(keys.keyForEnv(OLD)).toEqual([null, null])
  expect(keys.exportEnvironment()).toEqual([])
  expect(has(OLD)).toBe(false)
  // back to the first store: its key is exported again once the environment is exported
  setDefaultAuthDir(join(auth.dir, 'private'))
  expect(keys.exportEnvironment()).toEqual([OLD])
  expect(process.env[OLD]).toBe(KEY1)
})

test('switching the auth store leaves the shell\'s own variables alone', async () => {
  process.env[OLD] = 'from-the-shell-old-0001'
  await keys.saveKey('audit-custom', KEY1, { label: 'Audit', env: OLD })
  setDefaultAuthDir(join(auth.dir, 'second'))
  expect(process.env[OLD]).toBe('from-the-shell-old-0001')
  expect(keys.keyForEnv(OLD)).toEqual(['from-the-shell-old-0001', 'env'])
})

test('an inherited property name is no key provider', async () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    await expect(keys.saveKey(name, KEY1)).rejects.toThrow('unknown key provider')
    await expect(keys.forgetKey(name)).rejects.toThrow('unknown key provider')
    expect(() => keys.storedKey(name)).toThrow('unknown key provider')
    expect(() => keys.envName(name)).toThrow('unknown key provider')
    expect(() => keys.keyWithSource(name)).toThrow('unknown key provider')
  }
  expect(credentialStore().apiKeyEntries()).toEqual({})
  expect(keys.providerForEnv('toString')).toBeNull()
})

test('a custom provider may take an id that is an inherited property name', async () => {
  await keys.saveKey('constructor', KEY1, { label: 'Ctor', env: OLD })
  expect(keys.customProviders()).toEqual({ constructor: { label: 'Ctor', env: OLD } })
  expect(keys.envName('constructor')).toBe(OLD)
  expect(process.env[OLD]).toBe(KEY1)
  expect(keys.keyForEnv(OLD)).toEqual([KEY1, 'stored'])
  expect(keys.keyRows().find((r) => r.provider === 'constructor')).toMatchObject({ custom: true, env: OLD, source: 'stored' })
  expect(await keys.forgetKey('constructor')).toBe(true)
  expect(has(OLD)).toBe(false)
})

const noNetwork = async (): Promise<Response> => { throw new Error('no network in this test') }

test('signing out of an inherited property name is refused and leaves a custom key of that id alone', async () => {
  await keys.saveKey('constructor', KEY1, { label: 'Ctor', env: OLD })
  const logins = new LoginManager(credentialStore(), { fetchImpl: noNetwork, timeout_s: 1 })
  for (const name of ['constructor', 'toString']) await expect(logins.logout(name)).rejects.toThrow('unknown provider')
  expect(credentialStore().readApiKey('constructor')).toBe(KEY1)
  expect(process.env[OLD]).toBe(KEY1)
  // the store's own delete matches own entries only
  expect(await credentialStore().delete('toString')).toBe(false)
  expect(await credentialStore().delete('hasOwnProperty')).toBe(false)
})

test('a sign-in for an inherited property name is refused before anything starts', async () => {
  const logins = new LoginManager(credentialStore(), { fetchImpl: noNetwork, timeout_s: 1, callback_ports: { 'openai-codex': 0, anthropic: 0 } })
  for (const name of ['constructor', 'toString', '__proto__']) await expect(logins.start(name)).rejects.toThrow('unknown provider')
  expect(logins.sessions.size).toBe(0)
})
