/** The connector's client a steer came through stays on its record through every reading the harness makes of it: the
 *  run's persisted events (steer_queued, then steer_delivered or steer_undelivered, each record spread from the one
 *  before, as the runner writes them) read back by steersFromEvents — the list, the transcript, a restart's sweep of
 *  queued steers. A record from before the name was kept reads as it was (no client), and the body cannot carry one.
 *  Contract level: no app, no database. */

import { expect, test } from 'bun:test'
import { SteerBodySchema, steersFromEvents, type SteerRecord } from '@oasis-code/contract'

const queued = (id: string, seq: number, extra: Partial<SteerRecord> = {}): SteerRecord => ({
  id, run_id: 'run_1', session_id: 's_1', text: `words ${id}`, client_request_id: `key-${id}-0000`, status: 'queued',
  queued_at: '2026-10-16T00:00:00.000Z', queued_seq: seq, delivered_at: null, delivered_seq: null, request_index: null, reason: null, ...extra,
})

test("a steer's client is read back from the run's events through delivery, an undelivered end and a restart's sweep", () => {
  const claude = queued('st_a', 3, { by: 'connector', client: 'Claude' })
  const chatgpt = queued('st_b', 4, { by: 'connector', client: 'ChatGPT' })
  const mine = queued('st_c', 5)
  const events = [
    { seq: 3, event: 'steer_queued', data: { steer: claude } },
    { seq: 4, event: 'steer_queued', data: { steer: chatgpt } },
    { seq: 5, event: 'steer_queued', data: { steer: mine } },
    { seq: 7, event: 'steer_delivered', data: { steer: { ...claude, status: 'delivered', delivered_at: '2026-10-16T00:00:01.000Z', delivered_seq: 7, request_index: 2 } } },
    { seq: 8, event: 'steer_delivered', data: { steer: { ...mine, status: 'delivered', delivered_at: '2026-10-16T00:00:01.000Z', delivered_seq: 8, request_index: 2 } } },
  ]
  const live = steersFromEvents(events)
  expect(live.map((r) => [r.id, r.status, r.by ?? 'person', r.client ?? null])).toEqual([
    ['st_a', 'delivered', 'connector', 'Claude'], ['st_b', 'queued', 'connector', 'ChatGPT'], ['st_c', 'delivered', 'person', null],
  ])
  // a restart's sweep (runner.endQueuedSteers): each queued record read back, spread into its steer_undelivered
  const swept = live.filter((r) => r.status === 'queued').map((r, i) => ({ seq: 20 + i, event: 'steer_undelivered', data: { steer: { ...r, status: 'undelivered', reason: 'interrupted' } } }))
  const after = steersFromEvents([...events, ...swept])
  expect(after.find((r) => r.id === 'st_b')).toMatchObject({ status: 'undelivered', reason: 'interrupted', by: 'connector', client: 'ChatGPT' })
  expect(after.find((r) => r.id === 'st_a')!.client).toBe('Claude')
})

test('a record from before the client was kept reads as it was: a connector steer with no client, never a guessed one', () => {
  const old = queued('st_old', 1, { by: 'connector' })
  const [read] = steersFromEvents([{ seq: 1, event: 'steer_queued', data: { steer: old } }])
  expect(read).toEqual(old)
  expect(read!.client).toBeUndefined()
})

test('the body cannot name a client (strict): only the request that carried it can', () => {
  expect(SteerBodySchema.safeParse({ text: 'hi', client_request_id: 'key-00000001', client: 'ChatGPT' }).success).toBe(false)
  expect(SteerBodySchema.safeParse({ text: 'hi', client_request_id: 'key-00000001' }).success).toBe(true)
})
