/** The bots' identity moved to the contract (contract/src/bots.ts) gives the answers the app's outline gave at commit
 *  95dfa2f: the golden vectors (contract/src/bots_golden.ts) were computed once with that outline and are frozen data —
 *  this test never reads git. Synthetic ids only. */

import { describe, expect, test } from 'bun:test'
import { BOTS, colourFamily, identityTable, mainBot, memberBotOf, participantBots, sessionBots, botOf, turnFaceOf, EMPTY_BOT_TABLE, SHARE_BOTS, hashOf } from '@oasis-code/contract'
import { BOT_GOLDEN } from '@oasis-code/contract/bots-golden'

type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

describe('bots: the baseline outline\'s answers', () => {
  test('the set and the hash', () => {
    expect(BOTS.length).toBe(29)
    expect(SHARE_BOTS).toEqual([...BOTS, 'director', 'chatgpt'])
    // FNV-1a offset basis for the empty string; one known value
    expect(hashOf('')).toBe(2166136261)
    expect(hashOf('a')).toBe(0xe40c292c)
  })

  test('colour families', () => {
    for (const [bot, family] of Object.entries(BOT_GOLDEN.colour)) expect(colourFamily(bot)).toBe(family)
  })

  test('main bots', () => {
    for (const [session, bot] of Object.entries(BOT_GOLDEN.main)) expect(mainBot(session)).toBe(bot)
  })

  test('participant bots, the pool shared again once worn', () => {
    expect(BOT_GOLDEN.participants.length).toBe(12)
    for (const g of BOT_GOLDEN.participants) expect([...participantBots(g.session, g.ordered)]).toEqual(g.bots.map((p) => [...p]))
  })

  test('the identity table, and every bot of a row', () => {
    const t = BOT_GOLDEN.tables[0]!
    const table = identityTable(BOT_GOLDEN.identity_rows as Any, t.session)
    expect([...table.byParticipant]).toEqual(t.byParticipant.map((p) => [...p]))
    expect([...table.byMember]).toEqual(t.byMember.map((p) => [...p]))
    for (const r of BOT_GOLDEN.rows) expect(botOf(r.row as Any, table)).toBe(r.bot)
    for (const m of BOT_GOLDEN.members) expect(memberBotOf(table, m.group as Any, m.alias, m.model)).toBe(m.bot)
    for (const f of BOT_GOLDEN.faces) expect(turnFaceOf(table, f.run as Any, f.relay, f.interaction, f.continues)).toEqual(f.face)
    // no table (the app's after a reset): the participant falls back to its stable id's hash
    expect(botOf(BOT_GOLDEN.rows[1]!.row as Any, EMPTY_BOT_TABLE)).toBe(BOT_GOLDEN.after_reset)
  })

  test('a row whose collab names no participant (null) is skipped, as the outline skipped it', () => {
    const t = BOT_GOLDEN.tables[0]!
    const rows = [...BOT_GOLDEN.identity_rows, { id: 'run_00000000ffff', session_id: t.session, created_at: '2026-10-01T00:00:00.000Z', participant_alias: 'Q', participant_index: 0,
      collab: { participant_id: null, participant_role: null, placement: { group: { kind: 'relay', id: 'rel_00000000000a' } } } }]
    const table = identityTable(rows as Any, t.session)
    expect([...table.byParticipant]).toEqual(t.byParticipant.map((p) => [...p]))
    expect(botOf({ id: 'run_00000000ffff', session_id: t.session, model: 'm', spawned_by: 'human', parent_run_id: null, work_order: null, collab: { participant_id: null, participant_role: null } }, table))
      .toBe(BOTS[hashOf(`session:${t.session}`) % BOTS.length]!)
  })

  test('the rail\'s bots', () => {
    for (const s of BOT_GOLDEN.session_bots) expect(sessionBots(s.session, s.agents as Any)).toEqual([...s.bots])
  })

  test('every golden answer is a bot of the set (or none)', () => {
    const names = new Set<string>(SHARE_BOTS)
    for (const r of BOT_GOLDEN.rows) if (r.bot !== null) expect(names.has(r.bot)).toBe(true)
  })
})
