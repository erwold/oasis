// Offline tests of the secret / privacy rules. Secret-shaped values are assembled at run time from harmless pieces, so
// this file itself never carries one (and the repository scan does not flag it).
import assert from 'node:assert/strict'
import test from 'node:test'
import { allowEntryCovers, checkAllowList, parseMarkers, redact, scanText } from '../lib/scan.mjs'
import { riskyName } from '../scan-secrets.mjs'

const rules = (text, opts) => scanText('f.txt', text, opts).map((f) => f.rule)
const rep = (ch, n) => ch.repeat(n)

test('likely secrets are found by shape', () => {
  const samples = {
    'private-key': ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
    'anthropic-key': ['sk-', 'ant-', 'api03-', rep('A', 24)].join(''),
    'openai-key': ['sk-', 'proj-', rep('b', 40)].join(''),
    'github-token': ['gh', 'p_', rep('C', 36)].join(''),
    'aws-access-key': ['AK', 'IA', rep('D', 16)].join(''),
    'google-api-key': ['AI', 'za', rep('e', 35)].join(''),
    'huggingface-token': ['hf', '_', rep('f', 36)].join(''),
    jwt: ['ey', 'J', rep('g', 12), '.ey', 'J', rep('h', 12), '.', rep('i', 24)].join(''),
    'url-credentials': ['https://', 'someone:', rep('j', 12), '@corp-host.net'].join(''),
  }
  for (const [rule, value] of Object.entries(samples)) assert.ok(rules(`x = "${value}"`).includes(rule), `${rule} not found`)
})

test('placeholders and reserved names are not findings', () => {
  for (const t of [
    '/Users/alice/project', '/Users/person/x', '/home/runner/work', '/Users/<you>/x', '/Users/$USER/x', '/home/.npmrc', '/Users/p/x',
    ['https://', 'u:', rep('k', 12), '@example.invalid'].join(''),
    ['postgres://', 'u:', rep('k', 12), '@localhost'].join(''),
    'mac.tail1234.ts.net', 'host.tailnet.ts.net', 'sk-short',
  ]) assert.deepEqual(rules(t), [], t)
})

test('privacy markers: a real-looking home path, a personal mail domain, a non-placeholder tailnet', () => {
  assert.deepEqual(rules(['/Us', 'ers/', 'realperson/code'].join('')), ['home-path'])
  assert.deepEqual(rules(['someone', '@', 'gmail', '.com'].join('')), ['personal-email'])
  assert.deepEqual(rules(['box.', 'tail9f8e7d', '.ts.net'].join('')), ['tailnet-host'])
})

test('a finding carries a redacted shape, never the value', () => {
  const value = ['gh', 'p_', rep('Z', 36)].join('')
  const [f] = scanText('a.js', `t=${value}`)
  assert.equal(f.shape, redact(value))
  assert.ok(!JSON.stringify(f).includes(value))
  assert.equal(f.line, 1)
})

test('owner markers are matched case-insensitively and reported by number only', () => {
  const markers = parseMarkers('# private\nSecretHost\n\nmyname\n')
  const found = scanText('a.md', 'see secrethost and MYNAME', { markers })
  assert.deepEqual(found.map((f) => f.shape), ['marker #1', 'marker #2'])
  assert.ok(!JSON.stringify(found).toLowerCase().includes('secrethost'))
  assert.throws(() => parseMarkers('ab'), /at least 3/)
})

test('an allowance covers one exact file content only', () => {
  const key = ['-----BEGIN ', 'PRIVATE KEY-----'].join('')
  const entry = { path: 'tests/k.key', rule: 'private-key', sha256: 'a'.repeat(64), why: 'test key' }
  assert.equal(allowEntryCovers(entry, { rule: 'private-key', path: 'tests/k.key', sha256: 'a'.repeat(64) }), true)
  assert.equal(allowEntryCovers(entry, { rule: 'private-key', path: 'tests/k.key', sha256: 'b'.repeat(64) }), false)
  assert.equal(allowEntryCovers(entry, { rule: 'private-key', path: 'other/k.key', sha256: 'a'.repeat(64) }), false)
  const covered = scanText('tests/k.key', key, { allow: [entry], sha256: 'a'.repeat(64) })
  assert.equal(covered[0].allowed, true)
  const changed = scanText('tests/k.key', key, { allow: [entry], sha256: 'c'.repeat(64) })
  assert.equal(changed[0].allowed, undefined)
})

test('broad allowances are refused', () => {
  assert.throws(() => checkAllowList([{ path: 'tests/', rule: 'private-key', sha256: 'a'.repeat(64), why: 'x' }]), /too broad/)
  assert.throws(() => checkAllowList([{ path: 'tests/*.key', rule: 'private-key', sha256: 'a'.repeat(64), why: 'x' }]), /too broad/)
  assert.throws(() => checkAllowList([{ path: 'tests/k.key', rule: 'private-key', why: 'x' }]), /sha256/)
  assert.throws(() => checkAllowList([{ path: 'tests/k.key', rule: 'private-key', sha256: 'a'.repeat(64) }]), /needs path, rule, sha256 and why/)
})

test('risky file names', () => {
  for (const p of ['.env', 'a/.env.local', 'id_rsa', 'x/server.pem', 'logs/run.log', 'state.sqlite', 'creds/credentials.json', 'a/.oasis-code/auth.json']) assert.equal(riskyName(p), true, p)
  for (const p of ['.env.example', 'src/env.ts', 'docs/logging.md', 'tests/fixtures/tls/pinned.example.test.key']) assert.equal(riskyName(p), false, p)
})
