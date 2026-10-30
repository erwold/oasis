import assert from 'node:assert/strict'
import { test } from 'node:test'
import { callView, numberedLines } from '../src/state/callView.ts'
import { patchOf, viewLines } from '../src/state/diffs.ts'

test("an opened read: the file's numbered lines from where the read began, a folder's entries", () => {
  assert.deepEqual(numberedLines('430\tconst a = 1\n431\t\n432\t\treturn a', 430), [{ no: 430, text: 'const a = 1' }, { no: 431, text: '' }, { no: 432, text: '\treturn a' }])
  const file = callView('read_file', { path: 'x.ts', offset: 430 }, { status: 'ok', path: 'x.ts', from_line: 430, to_line: 431, total_lines: 1768, content: '430\ta\n431\tb' })
  assert.deepEqual(file, { kind: 'file', path: 'x.ts', from: 430, to: 431, total: 1768, lines: [{ no: 430, text: 'a' }, { no: 431, text: 'b' }] })
  assert.deepEqual(callView('read_file', {}, { status: 'ok', path: 'src', kind: 'directory', files: ['src/a.ts', 'src/b/'], truncated: true }), { kind: 'directory', path: 'src', files: ['src/a.ts', 'src/b/'], truncated: true })
})

test('an opened write or edit: its change; a command: its output; a search: its results; a page: its text; the rest, and a refusal: JSON', () => {
  assert.equal(callView('edit_file', { path: 'a.py' }, { status: 'ok', path: 'a.py', diff: '@@ -1 +1 @@\n-a\n+b' }).kind, 'change')
  assert.deepEqual(callView('bash', { command: 'ls' }, { status: 'failed', exit_code: 2, duration_ms: 40, stdout: '', stderr: 'no such file', command: 'ls x' }),
    { kind: 'command', command: 'ls x', exit: 2, status: 'failed', durationMs: 40, stdout: '', stderr: 'no such file', access: null })   // access: the result says nothing of it
  assert.deepEqual(callView('web_search', { query: 'q' }, { status: 'ok', results: [{ title: 'T', url: 'https://e.x', snippet: 's' }] }), { kind: 'results', title: 'q', items: [{ title: 'T', url: 'https://e.x', snippet: 's' }] })
  assert.deepEqual(callView('fetch_url', { url: 'https://a.x' }, { status: 'ok', url: 'https://a.x', final_url: 'https://b.x', text: 'page' }), { kind: 'page', url: 'https://b.x', text: 'page' })
  assert.equal(callView('read_file', { path: 'a' }, { status: 'refused', reason: 'outside' }).kind, 'raw')
  assert.equal(callView('present_ui', {}, { status: 'ok' }).kind, 'raw')
})

test("a write's or an edit's own diff reads as a file patch, numbered from its hunk", () => {
  const lines = viewLines(patchOf('--- a/a.py\n+++ b/a.py\n@@ -3,2 +3,2 @@\n def f():\n-    return 1\n+    return 2'))
  assert.deepEqual(lines.map((l) => (l.kind === 'line' ? `${l.tone}:${l.oldNo ?? '-'}/${l.newNo ?? '-'}` : 'fold')), ['ctx:3/3', 'del:4/-', 'add:-/4'])
})
