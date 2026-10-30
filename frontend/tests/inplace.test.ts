import assert from 'node:assert/strict'
import { test } from 'node:test'
import { undoable, undoLine } from '../src/state/inplace.ts'

test("a finished run of a folder edited in place that changed files with its tools can be undone; a copy's run cannot", () => {
  assert.equal(undoable({ status: 'done' }, 2, 'direct'), true)
  assert.equal(undoable({ status: 'error' }, 1, 'direct'), true)                 // a failed run may have written too
  assert.equal(undoable({ status: 'cancelled' }, 1, 'direct'), true)
  assert.equal(undoable({ status: 'running' }, 2, 'direct'), false)               // not while it writes
  assert.equal(undoable({ status: 'done' }, 0, 'direct'), false)                  // nothing written with a tool
  assert.equal(undoable({ status: 'done' }, 2, 'task'), false)                    // a worktree's run: its changes are on the copy
  assert.equal(undoable({ status: 'done' }, 2, null), false)
})

test('an undo says what went back, what was removed, and what was left alone', () => {
  assert.equal(undoLine({ run_id: 'r', restored: ['a.md', 'b.md'], removed: ['new.md'], conflicts: [], nothing: false }),
    'Put back 2 files as before the run; removed 1 file the run had made. What its commands changed is not undone.')
  assert.equal(undoLine({ run_id: 'r', restored: ['a.md'], removed: [], conflicts: [{ path: 'plan.txt', reason: 'changed since the run wrote it' }], nothing: false }),
    'Put back 1 file as before the run; left plan.txt alone (changed since the run wrote it). What its commands changed is not undone.')
  // each file left alone says why, in the server's words; nothing went back, so nothing is said of the commands
  assert.equal(undoLine({ run_id: 'r', restored: [], removed: [], conflicts: [
    { path: 'a.md', reason: 'changed since the run wrote it' }, { path: 'b.md', reason: 'it cannot be read (EACCES)' }, { path: 'c.md', reason: 'changed since the run wrote it' },
  ], nothing: false }), 'Left a.md, c.md alone (changed since the run wrote it); left b.md alone (it cannot be read (EACCES)).')
  assert.equal(undoLine({ run_id: 'r', restored: [], removed: [], conflicts: [], nothing: true }),
    'Nothing to undo: the run wrote no file with its tools, or its changes were undone already.')
  assert.equal(undoLine({ run_id: 'r', restored: [], removed: [], conflicts: [], nothing: false }), "Nothing left to undo: the run's changes were undone already.")
})
