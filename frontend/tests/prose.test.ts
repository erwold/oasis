import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createdSvg, filePatches } from '../src/state/diffs.ts'
import { fileNameOf, highlightLine, languageOf, linkKind, withoutChatGptMarkers } from '../src/state/highlight.ts'
import { mathMarkdown } from '../src/state/math.ts'

test('colouring never changes the text, and marks strings, keywords, calls and comments', () => {
  const lines: [string, string][] = [
    ['python3 -c "import xml.etree.ElementTree as ET; print(1)"  # checks the svg', 'sh'],
    ["def add(a, b):  # the bug: 'this' should add", 'python'],
    ['const x = await fetch(`/api/${id}`) // a url with // inside a string', 'ts'],
    ['a # not a comment in plain text', ''],
    ['', 'python'],
  ]
  for (const [line, lang] of lines) assert.equal(highlightLine(line, lang).map((t) => t.text).join(''), line)
  const sh = highlightLine(lines[0][0], 'sh')
  assert.deepEqual(sh.filter((t) => t.kind === 'string').map((t) => t.text), ['"import xml.etree.ElementTree as ET; print(1)"'])
  assert.equal(sh.at(-1)!.kind, 'comment')
  assert.equal(sh.at(-1)!.text, '# checks the svg')
  const py = highlightLine(lines[1][0], 'python')
  assert.deepEqual(py.filter((t) => t.kind === 'keyword').map((t) => t.text), ['def'])
  assert.deepEqual(py.filter((t) => t.kind === 'call').map((t) => t.text), ['add'])
  assert.equal(py.at(-1)!.text, "# the bug: 'this' should add")
  const ts = highlightLine(lines[2][0], 'ts')
  assert.equal(ts.find((t) => t.kind === 'string')!.text, '`/api/${id}`')
  assert.equal(ts.at(-1)!.text, '// a url with // inside a string')
  assert.equal(highlightLine(lines[3][0], '').some((t) => t.kind === 'comment'), false)
  assert.equal(languageOf(['language-python']), 'python')
  assert.equal(languageOf('hljs language-ts'), 'ts')
  assert.equal(languageOf(undefined), '')
})

test("a director's links: the web, inline images, and files in ChatGPT's sandbox", () => {
  assert.equal(linkKind('https://example.com/cat.png'), 'web')
  assert.equal(linkKind('data:image/png;base64,iVBOR'), 'inline')
  assert.equal(linkKind('data:text/html;base64,PHNjcmlwdD4='), 'other')
  assert.equal(linkKind('sandbox:/mnt/data/claude_opus_5_5_cat.png'), 'sandbox')
  assert.equal(linkKind('javascript:alert(1)'), 'other')
  assert.equal(linkKind('/api/sessions/s_1/attachments/a_2'), 'attachment')
  assert.equal(linkKind('/api/sessions/s_1/attachments/a_2/../../x'), 'other')
  assert.equal(fileNameOf('sandbox:/mnt/data/claude_opus_5_5_cat.png'), 'claude_opus_5_5_cat.png')
})

test('a patch is cut per file; a created SVG comes back whole, a modified one does not', () => {
  const patch = [
    'diff --git a/cat-art/cat.svg b/cat-art/cat.svg',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ b/cat-art/cat.svg',
    '@@ -0,0 +1,3 @@',
    '+<svg xmlns="http://www.w3.org/2000/svg">',
    '+<circle r="4"/>',
    '+</svg>',
    'diff --git a/calc.py b/calc.py',
    'index 2222222..3333333 100644',
    '--- a/calc.py',
    '+++ b/calc.py',
    '@@ -1,2 +1,2 @@',
    ' def add(a, b):',
    '-    return a - b',
    '+    return a + b',
    'diff --git a/logo.png b/logo.png',
    'new file mode 100644',
    'Binary files /dev/null and b/logo.png differ',
  ].join('\n')
  const files = filePatches(patch)
  assert.deepEqual([...files.keys()], ['cat-art/cat.svg', 'calc.py', 'logo.png'])
  assert.deepEqual(files.get('calc.py')!.lines.map((l) => l.tone), ['hunk', 'ctx', 'del', 'add'])
  assert.equal(files.get('calc.py')!.lines[2].text, '    return a - b')
  assert.equal(createdSvg('cat-art/cat.svg', files.get('cat-art/cat.svg')), '<svg xmlns="http://www.w3.org/2000/svg">\n<circle r="4"/>\n</svg>')
  assert.equal(createdSvg('calc.py', files.get('calc.py')), null)
  assert.equal(files.get('logo.png')!.binary, true)
  assert.equal(createdSvg('logo.png', files.get('logo.png')), null)
})

test('a link opens a web page or a mail message; anything else — a refused address, a relative path, an anchor, another scheme — opens nothing', async () => {
  const { linkTarget } = await import('../src/state/highlight.ts')
  assert.equal(linkTarget('https://example.com/a?b=1'), 'web')
  assert.equal(linkTarget('http://localhost:8080/'), 'web')
  assert.equal(linkTarget('mailto:someone@example.com'), 'mail')
  for (const href of ['', '   ', undefined, null, 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'calc.py', '/api/projects', '#top', 'vbscript:x', 'https://', 'https://exa mple.com']) {
    assert.equal(linkTarget(href), 'inert', String(href))
  }
})

test("ChatGPT's citation markers left in an answer are not shown; the words and a hard break stay", () => {
  assert.equal(withoutChatGptMarkers('利用了这一点。\ue200cite\ue202turn945630view0\ue202turn691511view2\ue201\n\nNext \ue200cite\ue202turn1view0\ue201 word  \nend \ue200cite\ue202tu'),
    '利用了这一点。\n\nNext word  \nend')
  assert.equal(withoutChatGptMarkers('plain  \ntext'), 'plain  \ntext')
})

test("ChatGPT's mention of an app is its name: the dollars of two mentions never make the words between them math", () => {
  const said = '我想把软件 [$github](app://connector_76869538009648d5b282a4bb21c3d157) 开源，再用 [$oasis-code](app://asdk_app_6ad058ab66d48191a07cc7c39e868316) 提交'
  assert.equal(withoutChatGptMarkers(said), '我想把软件 github 开源，再用 oasis-code 提交')
  assert.equal(mathMarkdown(withoutChatGptMarkers(said)).includes('$$'), false)
  assert.equal(withoutChatGptMarkers('a [link](https://x.y) and $x$'), 'a [link](https://x.y) and $x$')
})
