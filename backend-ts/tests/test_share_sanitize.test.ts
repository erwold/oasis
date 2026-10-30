/** The share sanitizer and the sensitive-source classifier (src/share): what every exported string passes through.
 *  All values below are synthetic. */

import { expect, test } from 'bun:test'
import { ShareSanitizer, stripInvisible, type SanitizerContext } from '../src/share/sanitize.ts'
import { sensitivePath, sensitiveTool } from '../src/share/sensitive.ts'

// a synthetic user's name, put into its home path at run time: the committed source holds no literal home path for the
// repository's privacy scan to find (scripts/oss/lib/scan.mjs)
const TESTER = 'zed-tester', OTHER = 'other', WIN = 'Win'

const ZWSP = '\u200B'
const ctx = (over: Partial<SanitizerContext> = {}): SanitizerContext => ({
  token: 'synthetic-app-token-0123456789abcdef', project_dirs: ['/work/acme/repo'], data_dirs: ['/var/lib/oasis-data'], home_dirs: [`/Users/${TESTER}`],
  username: 'zedtester', ...over,
})
const clean = (text: string, over: Partial<SanitizerContext> = {}) => new ShareSanitizer(ctx(over)).text(text)

test('the app token is scrubbed exactly wherever it stands, short or long; an empty token matches nothing', () => {
  expect(clean('open http://127.0.0.1:8399/?t=synthetic-app-token-0123456789abcdef now')).not.toContain('synthetic-app-token')
  // a short explicitly configured token (the test suite's own) is scrubbed too
  const s = new ShareSanitizer(ctx({ token: 'test-token' }))
  expect(s.text('header x: test-token and test-token')).toBe('header x: [redacted] and [redacted]')
  expect(s.redacted.session_token).toBe(2)
  // split by invisible characters or a variation selector, it is still the token
  expect(clean(`synthetic-app${ZWSP}-token-0123456789abc\uFE0Fdef`)).toBe('[redacted]')
  // its URL-encoded form
  expect(clean('x', { token: 'a b/c+d' })).toBe('x')
  expect(clean('?k=a%20b%2Fc%2Bd', { token: 'a b/c+d' })).not.toContain('a%20b')
  // no token: nothing is matched, nothing is emptied
  const none = new ShareSanitizer(ctx({ token: '' }))
  expect(none.text('ordinary words stay')).toBe('ordinary words stay')
  expect(none.redacted.session_token).toBe(0)
})

test('credential assignments are masked whole in ordinary prose, titles and director text', () => {
  const cases: [string, string][] = [
    ['password=123456', 'password=[redacted]'],
    ['token=abc', 'token=[redacted]'],
    ['API_KEY = opaqueplain', 'API_KEY = [redacted]'],
    ['password: huntertwo', 'password: [redacted]'],
    ['password="correct horse battery staple" then more', 'password="[redacted]" then more'],
    ['password="first\nsecond" after', 'password="[redacted]" after'],
    ["db.password: 'one two'", "db.password: '[redacted]'"],
    ['{"apiKey": "k-123", "name": "x"}', '{"apiKey": "[redacted]", "name": "x"}'],
    ['githubToken = ghx', 'githubToken = [redacted]'],
    ['export OPENAI_API_KEY=plainvalue', 'export OPENAI_API_KEY=[redacted]'],
    ['run with --password hunter2 now', 'run with --password [redacted] now'],
    ['client_secret := zz', 'client_secret := [redacted]'],
  ]
  for (const [input, want] of cases) expect(clean(input)).toBe(want)
  // a YAML block scalar: the whole indented block goes
  expect(clean('db:\n  password: |\n    first\n    second\n  user: app\n')).toBe('db:\n  password: [redacted]\n  user: app\n')
  expect(clean('password: >-\n  folded\n  lines\nnext: 1')).toBe('password: [redacted]\nnext: 1')
  // a triple-quoted Python literal, one line or several
  expect(clean('api_key = """opaque-secret""" # set')).toBe('api_key = """[redacted]""" # set')
  expect(clean("token = '''line one\nline two''' done")).toBe("token = '''[redacted]''' done")
  // an unterminated quoted value: the rest of the text
  expect(clean('secret="never closed and more')).toBe('secret="[redacted]')
})

test('only explicit references, types and placeholders stay after a secret-named key', () => {
  for (const kept of ['token = process.env.API_TOKEN', 'password: string', 'api_key: ${API_KEY}', 'secret = os.getenv("X")', 'token: null', 'password=<your password>', 'token = [redacted]'])
    expect(clean(kept)).toBe(kept)
  // a plain identifier is not an exemption
  expect(clean('token = newToken')).toBe('token = [redacted]')
  // keys that only contain a secret word are not secret-named
  for (const kept of ['max_tokens: 4096', 'tokenizer: cl100k', 'passwordless: true', 'input_tokens=12']) expect(clean(kept)).toBe(kept)
})

test('headers, schemes, URLs, private keys and known token shapes', () => {
  expect(clean('Authorization: Bearer abcdefgh')).toBe('Authorization: [redacted]')
  expect(clean('send Bearer abcdefgh please')).toBe('send Bearer [redacted] please')
  expect(clean('Cookie: sid=abc; theme=dark')).toBe('Cookie: [redacted]')
  expect(clean('clone https://user:pa55@git.example.com/x.git')).toBe('clone https://[redacted]@git.example.com/x.git')
  expect(clean('https://s3.example.com/f?X-Amz-Signature=abc123&x=1')).toBe('https://s3.example.com/f?X-Amz-Signature=[redacted]&x=1')
  // synthetic shapes put together at run time, as the ghp_/AKIA ones: the committed source holds no literal key shape
  // for the repository's secret scan to find (scripts/oss/scan-secrets.mjs)
  const begin = (kind: string) => '-----' + 'BEGIN ' + kind + ' PRIVATE KEY-----'
  const pem = `${begin('OPENSSH')}\nAAAAsynthetic\n-----END OPENSSH PRIVATE KEY-----`
  expect(clean(`key:\n${pem}\nend`)).toBe('key:\n[redacted private key]\nend')
  expect(clean(`${begin('RSA')}\nunterminated`)).toBe('[redacted private key]')
  for (const shape of ['sk-' + 'ant-api03-SYNTHETICsyntheticSYNTHETIC00', 'ghp_' + 'A'.repeat(36), 'AKIA' + 'B'.repeat(16), 'xo' + 'xb-1234567890-synthetic', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl'])
    expect(clean(`value ${shape} end`)).toBe('value [redacted] end')
})

test('invisible characters cannot split a key name or a secret; legitimate joiners stay', () => {
  expect(clean(`pass${ZWSP}word=${ZWSP}hunter2`)).toBe('password=[redacted]')
  expect(clean('API\uFE0F_KEY=opaque')).toBe('API_KEY=[redacted]')
  expect(clean('pass\u00ADword: x1')).toBe('password: [redacted]')
  expect(clean('to\u2060ken=\u202Eabc')).toBe('token=[redacted]')
  // emoji ZWJ sequences, keycaps, a subdivision flag, Persian ZWNJ, Devanagari ZWJ, an ideographic variation sequence
  for (const kept of ['👩\u200D💻 family 👨\u200D👩\u200D👧', '1\uFE0F\u20E3', '❤\uFE0F', '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 'می\u200Cخواهم', 'क्\u200Dष', '葛\u{E0100}'])
    expect(stripInvisible(kept).text).toBe(kept.normalize('NFC'))
  // a variation selector after a Latin letter, a stray tag run, a BOM: removed and counted
  const s = new ShareSanitizer(ctx())
  expect(s.text('a\uFE0Fb\u{E0041}c\uFEFFd')).toBe('abcd')
  expect(s.redacted.invisible_chars).toBe(3)
})

test('paths become project-relative or masked; the account name and emails are masked', () => {
  expect(clean('edited /work/acme/repo/src/app.ts and /work/acme/repo')).toBe('edited src/app.ts and .')
  expect(clean('data at /var/lib/oasis-data/db.sqlite')).toBe('data at <app-data>/db.sqlite')
  expect(clean(`see /Users/${TESTER}/notes.md and /home/${OTHER}/x and C:\\Users\\${WIN}\\f`)).toBe('see ~/notes.md and ~/x and ~\\f')
  expect(clean('zedtester ran it; mail ada@example.org; keep logo@2x.png')).toBe('[user] ran it; mail [email]; keep logo@2x.png')
  // a common account name is never masked as a word
  expect(clean('the admin panel', { username: 'admin' })).toBe('the admin panel')
})

test('a long run without a separator costs linear time (the bounded key parser)', () => {
  const s = new ShareSanitizer(ctx({ token: '' }))
  const t0 = performance.now()
  s.text('A'.repeat(200) + '=')
  s.text('A'.repeat(200_000) + '=')
  s.text(('x'.repeat(60) + ' ').repeat(20_000) + '=')
  s.text(('token' + 'a'.repeat(100) + ' ').repeat(5_000))
  expect(performance.now() - t0).toBeLessThan(1_500)
})

test('long texts are cut and say so; labels are one line', () => {
  const s = new ShareSanitizer(ctx())
  expect(s.text('x'.repeat(50), 10)).toBe(`${'x'.repeat(10)}\n…[cut: 40 more characters]`)
  expect(s.truncated).toBe(1)
  expect(s.label('a\n\n b\tc', 200)).toBe('a b c')
})

test('sensitive sources are recognized from paths and commands, obfuscation removed first', () => {
  for (const p of ['.env', 'config/.env.production', '/home/u/.ssh/id_ed25519', '~/.aws/credentials', '~/.claude/.credentials.json', '.codex/auth.json', 'secrets.yaml', 'server.pem',
    '/var/lib/oasis-data/session-token', '/proc/self/environ', '.npmrc', '~/.config/gh/hosts.yml'])
    expect(sensitivePath(p, ['/var/lib/oasis-data'])).toBe(true)
  for (const p of ['src/app.ts', 'README.md', 'docs/env-setup.md']) expect(sensitivePath(p)).toBe(false)
  for (const command of ['env', '/usr/bin/env', 'env -0', 'env --null | sort', '/usr/bin/env -0 > out.txt', 'printenv', 'env | sort', 'set', 'cat .env', "node -p 'process.env.INTERNAL_API_KEY'", 'python -c \'import os; print(os.getenv("INTERNAL_API_KEY"))\'',
    'gh auth token', 'security find-generic-password -s x -w', 'echo $GITHUB_TOKEN', 'aws configure export-credentials', 'cat ~/.ssh/id_rsa'])
    expect(sensitiveTool('bash', { command })).toBe(true)
  for (const command of ['ls -la', 'bun test', 'env FOO=1 bun run build', 'git status']) expect(sensitiveTool('bash', { command })).toBe(false)
  // the caller hands the classifier the cleaned text: an obfuscated path is the path
  expect(sensitiveTool('read_file', { path: stripInvisible(`.e${ZWSP}nv`).text })).toBe(true)
})
