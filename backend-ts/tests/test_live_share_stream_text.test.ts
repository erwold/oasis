/** An answer still being written, as a live share may show it (src/share/live/stream_text.ts): every frame — every
 *  prefix of the text, character by character — sanitized, must be how the finished answer sanitized begins, and must
 *  never hold a secret's characters. Synthetic secrets only, put together at run time (the repository's scans). */

import { expect, test } from 'bun:test'
import { ShareSanitizer, type SanitizerContext } from '../src/share/sanitize.ts'
import { stableOpenText, unclosedFrom } from '../src/share/live/stream_text.ts'

const USER = 'zedsynthetic'
const HOME = ['', 'Users', USER].join('/')
const TOKEN = 'live-test-session-token-' + 'Q'.repeat(12)
const ctx: SanitizerContext = { token: TOKEN, project_dirs: [], data_dirs: [], home_dirs: [HOME], username: USER }
const san = (t: string) => new ShareSanitizer(ctx).text(t)

const GH = 'ghp_' + 'Z'.repeat(36)
const BEARER = 'abcdef' + 'SECRETBEARER' + 'ghijkl'
const PW = 'multi word ' + 'SECRETPASSWORD' + ' value'
const YAML1 = 'line-one-' + 'SECRETYAML'
const YAML2 = 'line-two-' + 'SECRETYAML'
const KEYBODY = 'b3BlbnNzaC1rZXktdjEAAAAA' + 'SECRETKEYBODY'
const TRIPLE = 'sk-' + 'proj-' + 'T'.repeat(30)
const BEGIN = '-----BEGIN' + ' OPENSSH PRIVATE KEY-----'
const END = '-----END' + ' OPENSSH PRIVATE KEY-----'
const EMAIL_LOCAL = 'zed.example'
const EMAIL = `${EMAIL_LOCAL}@example.org`

/** the secrets' own characters: none of these may appear in any frame (a piece long enough to mean something) */
const SECRET_PARTS = [GH.slice(4, 20), 'SECRETBEARER', 'SECRETPASSWORD', 'SECRETYAML', 'SECRETKEYBODY', TRIPLE.slice(8, 24), TOKEN.slice(0, 20), USER, EMAIL_LOCAL]

const TEXTS: string[] = [
  `Set it with:\nexport GH_TOKEN=${GH}\nthen run it.\n`,
  `curl -H 'Authorization: Bearer ${BEARER}' https://api.example.com/x\nok\n`,
  `config:\npassword = "${PW}"\nnext line\n`,
  `db:\n  password: |\n    ${YAML1}\n    ${YAML2}\nnext: ok\n`,
  `Here is the key:\n${BEGIN}\n${KEYBODY}\nQUFBQUFBQUFBQUFBQUFB\n${END}\ndone\n`,
  `code:\nAPI_KEY = """\n${TRIPLE}\n"""\nafter\n`,
  `write to ${EMAIL} please\nand look in ${HOME}/projects/demo\n`,
  `the app said ${TOKEN} once\n`,
]

test('every prefix of every adversarial answer: its shown part, sanitized, is how the finished answer begins and holds no secret', () => {
  for (const full of TEXTS) {
    const final = san(full)
    for (const part of SECRET_PARTS) expect(final.includes(part), `final holds ${part}: ${final}`).toBe(false)
    let previous = ''
    for (let k = 0; k <= full.length; k++) {
      const raw = full.slice(0, k)
      const shown = stableOpenText(raw, ctx)
      expect(raw.startsWith(shown)).toBe(true)
      const frame = san(shown)
      expect(final.startsWith(frame), `frame ${JSON.stringify(frame)} of ${JSON.stringify(raw)} is not how ${JSON.stringify(final)} begins`).toBe(true)
      for (const part of SECRET_PARTS) expect(frame.includes(part), `frame at ${k} holds ${part}`).toBe(false)
      // the shown part never shrinks as more is written (a later frame only adds lines)
      expect(frame.startsWith(previous) || previous === '', `frame at ${k} took back what it showed`).toBe(true)
      previous = frame
    }
  }
})

test('only completed lines; an unclosed private key, triple quote or secret block scalar withholds from its line on', () => {
  expect(stableOpenText('first line\nsecond is being writ', ctx)).toBe('first line\n')
  expect(stableOpenText('no newline yet', ctx)).toBe('')
  expect(unclosedFrom(`a\n${BEGIN}\nbody\n`)).toBe(2)
  expect(unclosedFrom(`a\n${BEGIN}\nbody\n${END}\n`)).toBe(`a\n${BEGIN}\nbody\n${END}\n`.length)
  expect(unclosedFrom('x\ny = """\nopen\n')).toBe(2)
  expect(unclosedFrom('x\ny = """\nclosed\n"""\n')).toBe('x\ny = """\nclosed\n"""\n'.length)
  expect(unclosedFrom('a: 1\nsecret: |\n  value\n')).toBe(5)
  expect(unclosedFrom('a: 1\nsecret: |\n  value\nb: 2\n')).toBe('a: 1\nsecret: |\n  value\nb: 2\n'.length)
  // a block scalar of a key that names nothing secret is not withheld
  expect(unclosedFrom('notes: |\n  hello\n')).toBe('notes: |\n  hello\n'.length)
})
