import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeStarts, filePatches, viewLines, type ViewLine } from '../src/state/diffs.ts'

const patchOf = (path: string, body: string) => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${body}`
const shown = (lines: ViewLine[]) => lines.map((l) => (l.kind === 'fold' ? `~${l.count}` : `${l.tone}:${l.oldNo ?? '-'}/${l.newNo ?? '-'}:${l.text}`))

test('the file whole, numbered from its hunk head: a removed line keeps its old number, an added one takes the new', () => {
  const file = filePatches(patchOf('calc.py', '@@ -1,4 +1,4 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n \n def sub(a, b):\n'))
  const lines = viewLines(file.get('calc.py')!)
  assert.deepEqual(shown(lines), ['ctx:1/1:def add(a, b):', 'del:2/-:    return a - b', 'add:-/2:    return a + b', 'ctx:3/3:', 'ctx:4/4:def sub(a, b):'])
  assert.deepEqual(changeStarts(lines), [1])                                       // one change: the removed and added lines together
})

test('a file too long to show whole folds its unchanged runs far from a change, every change kept', () => {
  const body = ['@@ -1,300 +1,300 @@', ...Array.from({ length: 300 }, (_, i) => (i === 10 ? '-old' : i === 250 ? '+new' : ` line ${i + 1}`))].join('\n')
  const lines = viewLines(filePatches(patchOf('long.txt', body)).get('long.txt')!, 100)
  assert.ok(lines.length < 300)
  assert.ok(lines.some((l) => l.kind === 'line' && l.tone === 'del' && l.text === 'old'))
  assert.ok(lines.some((l) => l.kind === 'line' && l.tone === 'add' && l.text === 'new'))
  const folds = lines.filter((l): l is Extract<ViewLine, { kind: 'fold' }> => l.kind === 'fold')
  assert.equal(lines.filter((l) => l.kind === 'line').length + folds.reduce((n, f) => n + f.count, 0), 300)   // nothing lost, only folded
  assert.equal(changeStarts(lines).length, 2)
  assert.equal(viewLines(filePatches(patchOf('long.txt', body)).get('long.txt')!).some((l) => l.kind === 'fold'), false)   // short enough: whole
})
