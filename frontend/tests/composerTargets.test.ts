import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { forgetTarget, rememberedTarget, rememberTarget } from '../src/state/composerTargets.ts'

const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) } } })
beforeEach(() => stored.clear())

test("each session keeps the target last chosen for it; a deleted session's choice goes; nothing chosen is none", () => {
  assert.equal(rememberedTarget('s1'), null)
  rememberTarget('s1', 'director')
  rememberTarget('s2', 'agent')
  rememberTarget('s1', 'agent')
  assert.equal(rememberedTarget('s1'), 'agent')
  assert.equal(rememberedTarget('s2'), 'agent')
  rememberTarget('s3', 'chatgpt')
  forgetTarget('s2')
  assert.equal(rememberedTarget('s2'), null)
  assert.equal(rememberedTarget('s3'), 'chatgpt')
})

test('what the storage holds that is no target is none; a storage that cannot be read or written changes nothing', () => {
  stored.set('oasis-code.composerTargets', JSON.stringify({ s1: 'nonsense', s2: 'director' }))
  assert.equal(rememberedTarget('s1'), null)
  assert.equal(rememberedTarget('s2'), 'director')
  stored.set('oasis-code.composerTargets', '{not json')
  assert.equal(rememberedTarget('s2'), null)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked') } })
  assert.doesNotThrow(() => rememberTarget('s1', 'agent'))
  assert.equal(rememberedTarget('s1'), null)
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) } } })
})
