/** A tool call whose arguments take long to write (a whole document for write_file or present_ui) says how far it got
 *  while it streams, so the thread shows work instead of silence; the event is live only, never written. */
import { expect, test } from 'bun:test'
import { TRANSIENT_EVENTS as CONTRACT_TRANSIENT } from '@oasis-code/contract'
import { formingTarget, RunEventMapper } from '../src/agent/events.ts'
import type { AgentEvent } from '../src/agent/loop.ts'
import { TRANSIENT_EVENTS } from '../src/agent/runner.ts'
import { toolCallPart } from '../src/llm/messages.ts'

const start = (index: number, tool: string, id: string): AgentEvent => ({ type: 'part_start', index, part: toolCallPart(tool, '', id) })
const delta = (index: number, args: string): AgentEvent => ({ type: 'part_delta', index, delta: { part_kind: 'tool-call', args_delta: args } })

test('a call streaming its arguments says how far it got, by size or by time, and stops saying it once the call came', () => {
  let now = 0
  const mapper = new RunEventMapper(() => now)
  const progress = (e: AgentEvent) => mapper.map(e).filter(([n]) => n === 'tool_call_progress').map(([, d]) => d)
  expect(progress(start(0, 'write_file', 'call_1'))).toEqual([])
  // its path names what it writes once the string has closed; less than 4 KB within a second says nothing
  const head = ['{"path":"site/flow', '.html","content":"<html>']
  expect(progress(delta(0, head[0]!))).toEqual([])
  expect(progress(delta(0, head[1]!))).toEqual([])
  const written = head.join('').length
  // 4 KB more: said at once, with what it writes
  const big = 'x'.repeat(4096)
  expect(progress(delta(0, big))).toEqual([{ tool: 'write_file', tool_call_id: 'call_1', chars: written + 4096, path: 'site/flow.html' }])
  // a little more, a second later: said again
  now = 1000
  expect(progress(delta(0, 'yy'))).toEqual([{ tool: 'write_file', tool_call_id: 'call_1', chars: written + 4096 + 2, path: 'site/flow.html' }])
  // nothing more within the second: silent
  now = 1500
  expect(progress(delta(0, 'z'))).toEqual([])
  // the part ends: a later delta at that index (the next response's part) is not this call's
  expect(progress({ type: 'part_end', index: 0, part: toolCallPart('write_file', '{}', 'call_1') })).toEqual([])
  now = 9000
  expect(progress(delta(0, big))).toEqual([])
})

test('a call that streams in less than a second and under 4 KB never says it', () => {
  const mapper = new RunEventMapper(() => 0)
  const events = [start(0, 'read_file', 'c'), delta(0, '{"path":"a.ts"}'), { type: 'part_end', index: 0, part: toolCallPart('read_file', '{"path":"a.ts"}', 'c') } as AgentEvent]
  expect(events.flatMap((e) => mapper.map(e)).map(([n]) => n)).toEqual([])
})

test('what a forming call works on: the first of path, title or url whose string has closed, unescaped', () => {
  expect(formingTarget('{"path":"a/b.html","content":"…')).toEqual({ path: 'a/b.html' })
  expect(formingTarget('{"path":"a/b')).toEqual({})
  expect(formingTarget('{"version":1,"surface_id":"s","title":"Flow \\"GRPO\\"","kind":"html"')).toEqual({ title: 'Flow "GRPO"' })
  expect(formingTarget('{"command":"ls"}')).toEqual({})
})

test('the progress is live only: the harness and the contract both keep it out of the record', () => {
  expect(TRANSIENT_EVENTS.has('tool_call_progress')).toBe(true)
  expect(CONTRACT_TRANSIENT).toContain('tool_call_progress')
})
