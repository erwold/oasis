import { expect, test } from 'bun:test'
import { emptyRemoteCursor, remoteLines } from '../src/agent/watches/remote_cursor.ts'
import { MAX_LINE_CHARS } from '../src/agent/watches/conditions.ts'

test('remote cursor survives JSON restart at every UTF8 byte boundary, preserving partial lines', () => {
  const bytes=Buffer.from('step=1 中文🙂\nloss=NaN 最后一行')
  for (let split=0;split<=bytes.length;split++) {
    const first=remoteLines(emptyRemoteCursor(),bytes.subarray(0,split),false)
    const restored=JSON.parse(JSON.stringify(first.state))
    const last=remoteLines(restored,bytes.subarray(split),true)
    expect([...first.lines,...last.lines]).toEqual(['step=1 中文🙂','loss=NaN 最后一行'])
    expect(last.state.utf8).toBe('');expect(last.state.partial).toBe('');expect(last.state.eof).toBe(true)
  }
})

test('an overlong remote line tail is not treated as a new match after restart', () => {
  const first=remoteLines(emptyRemoteCursor(),Buffer.from('x'.repeat(MAX_LINE_CHARS+20)),false)
  expect(first.lines).toHaveLength(1);expect(first.state.skipping).toBe(true)
  const second=remoteLines(JSON.parse(JSON.stringify(first.state)),Buffer.from('ERROR not-a-new-line\nreal line\n'),false)
  expect(second.lines).toEqual(['real line'])
  const ending=remoteLines(JSON.parse(JSON.stringify(first.state)),Buffer.from('tail'),true)
  expect(ending.lines).toEqual([]);expect(ending.state.eof).toBe(true)
})
