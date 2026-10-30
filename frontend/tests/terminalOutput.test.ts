import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { OutputWindow } from '../src/api/types.ts'
import { terminalStatus, terminalText } from '../src/state/terminalOutput.ts'

const base: OutputWindow = { execution_id: 'x1', stream: 'stdout', offset: 0, returned_bytes: 0, total_bytes: 0, next_offset: 0, eof: true, running: false, status: 'succeeded', exit_code: 0, truncated_at_cap: false, text: '' }

test('a log the harness cannot read now is said as unavailable, never as an empty log; an unknown state is never "still running"', () => {
  const away: OutputWindow = { ...base, available: false, connection_state: 'disconnected', status: 'unknown', running: true, eof: false, total_bytes: null }
  assert.equal(terminalText(away, 'stdout', 0), '(log unavailable · disconnected)')
  assert.doesNotMatch(terminalText(away, 'stdout', 0), /nothing on/)
  assert.equal(terminalStatus(away), 'status unknown')
  assert.doesNotMatch(terminalStatus(away), /still running|bytes/)
  // a running command whose host answers: still running, its bytes counted
  const live: OutputWindow = { ...base, available: true, status: 'running', running: true, returned_bytes: 5, total_bytes: 5, text: 'hello', eof: false }
  assert.equal(terminalText(live, 'stdout', 0), 'hello\n…[more in the log]')
  assert.equal(terminalStatus(live), '5 of 5 bytes · still running')
  // a local command that wrote nothing on stdout but on stderr: as before
  assert.equal(terminalText(base, 'stdout', 12), '(nothing on stdout; 12 B on stderr)')
  assert.equal(terminalStatus(base), '0 of 0 bytes')
  assert.equal(terminalText(null, 'stdout', 0), 'loading…')
})
