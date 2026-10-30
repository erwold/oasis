import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentMatches, agentMentionToken, agentMentionsOf, insertAgent, insertMention, insertTool, mentionLabel, mentionsOf, nextParticipantId, participantsOf, queryAt, segments, toolsMatching } from '../src/state/entities.ts'

test('mentions are found in text; a person or an email stays text', () => {
  const text = 'why does @calc.py::add fail? see @src/api.ts, ask @alice or mail a@b.com'
  assert.deepEqual(mentionsOf(text), [{ path: 'calc.py', symbol: 'add' }, { path: 'src/api.ts', symbol: null }])
  const segs = segments(text)
  assert.deepEqual(segs.map((s) => ('text' in s ? s.text : s.raw)), ['why does ', '@calc.py::add', ' fail? see ', '@src/api.ts', ', ask @alice or mail a@b.com'])
  assert.equal(mentionLabel({ path: 'src/deep/api.ts', symbol: 'load' }), 'api.ts::load')
  assert.deepEqual(mentionsOf('@a.py @a.py'), [{ path: 'a.py', symbol: null }])
})

test('the query at the caret and the insertion', () => {
  assert.deepEqual(queryAt('fix @cal', 8), { start: 4, query: 'cal' })
  assert.deepEqual(queryAt('@', 1), { start: 0, query: '' })
  assert.equal(queryAt('fix cal', 7), null)
  assert.equal(queryAt('mail a@b', 8), null)
  const out = insertMention('fix @cal now', 4, 8, { path: 'calc.py', symbol: 'add' })
  assert.equal(out.text, 'fix @calc.py::add  now')
  assert.equal(out.caret, 'fix @calc.py::add '.length)
})

test('an agent named with @ is a chip in the words, read as a name by the rest; a file mention beside it stays one', () => {
  const opus = agentMentionToken('Claude Opus 5.5', 'anthropic:claude-opus-5-5')
  const astra = agentMentionToken('GPT-6 Astra', 'openai:gpt-6-astra')
  const text = `测试 marvelous design 衣物模拟，${opus} 来执行，${astra} 来监督并给予反馈，看 @calc.py`
  assert.deepEqual(agentMentionsOf(text), [{ label: 'Claude Opus 5.5', model: 'anthropic:claude-opus-5-5', alias: null }, { label: 'GPT-6 Astra', model: 'openai:gpt-6-astra', alias: null }])
  const kinds = segments(text).map((s) => ('agent' in s ? `agent:${s.agent.model}` : 'mention' in s ? `file:${s.mention.path}` : 'text'))
  assert.deepEqual(kinds, ['text', 'agent:anthropic:claude-opus-5-5', 'text', 'agent:openai:gpt-6-astra', 'text', 'file:calc.py'])
  assert.deepEqual(mentionsOf(text), [{ path: 'calc.py', symbol: null }])          // the agent tokens are no file mentions
  assert.equal(agentMentionToken('a [b] c', 'x:y'), '@[a  b  c](agent:x:y)')       // brackets never break the token
  // a name typed twice names the agent twice (the order matters to the relay)
  assert.equal(agentMentionsOf(`${opus} then ${opus}`).length, 2)
})

test('the @query allows spaces (a model name has them) and opens after Chinese punctuation; an e-mail or a chip is no query', () => {
  assert.deepEqual(queryAt('模拟，@claude opus 5', '模拟，@claude opus 5'.length), { start: 3, query: 'claude opus 5' })
  assert.deepEqual(queryAt('模拟，@', 4), { start: 3, query: '' })
  assert.deepEqual(queryAt('a。@gpt', 6), { start: 2, query: 'gpt' })
  assert.deepEqual(queryAt('see (@gpt6 astra', 16), { start: 5, query: 'gpt6 astra' })
  // written without spaces: right after a Chinese, Japanese or Korean character the @ opens too
  assert.deepEqual(queryAt('的地方地方@', 6), { start: 5, query: '' })
  assert.deepEqual(queryAt('地方@claude', 9), { start: 2, query: 'claude' })
  assert.deepEqual(queryAt('これ@gpt', 6), { start: 2, query: 'gpt' })
  assert.deepEqual(queryAt('여기@gpt', 6), { start: 2, query: 'gpt' })
  assert.deepEqual(mentionsOf('看看@calc.py'), [{ path: 'calc.py', symbol: null }])
  assert.equal(queryAt('mail a1@b', 9), null)                                                      // a digit before it: an address
  assert.equal(queryAt('mail a@b.com', 12), null)
  assert.equal(queryAt(`${agentMentionToken('GPT-6 Astra', 'openai:gpt-6-astra')} `, 41), null)     // right after a chip
  assert.equal(queryAt('@' + 'x'.repeat(49), 50), null)                                             // too long to be a name
  assert.equal(queryAt('a @b\nc', 6), null)                                                        // a new line closes it
  const out = insertAgent('模拟，@claude opus 来执行', 3, 15, { label: 'Claude Opus 5.5', model: 'anthropic:claude-opus-5-5' })
  assert.match(out.text, /^模拟，@\[Claude Opus 5\.5\]\(agent:anthropic:claude-opus-5-5#pt_[0-9a-f]{6}\) {2}来执行$/)   // the participant: an id of its own
  assert.equal(out.caret, out.text.indexOf(')') + 2)
})

test('a participant added gets an id no one in the message holds; one named again keeps its own — two on one model stay two', () => {
  const opus = { label: 'Claude Opus 5.5', model: 'anthropic:claude-opus-5-5' }
  const one = insertAgent('', 0, 0, opus).text
  const first = participantsOf(one)[0]!.id
  assert.match(first, /^pt_[0-9a-f]{6}$/)
  assert.notEqual(nextParticipantId(one), first)
  const two = insertAgent(`${one}and @cl`, one.length + 4, one.length + 7, opus).text       // another participant on the same model
  const ids = participantsOf(two).map((p) => p.id)
  assert.equal(ids.length, 2)
  assert.equal(ids[0], first)
  const again = insertAgent(`${two}then @cl`, two.length + 5, two.length + 8, { ...opus, alias: first }).text   // the first named again
  assert.deepEqual(participantsOf(again).map((p) => p.id), ids)
  assert.equal(agentMentionsOf(again).length, 3)
  assert.ok(!ids.includes(nextParticipantId(again)))
})

test('a route answers an @query by its label, its id or its provider, letters and digits only, in order', () => {
  const opus = { id: 'anthropic:claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic' }
  const astra = { id: 'openai:gpt-6-astra', label: 'GPT-6 Astra', provider: 'openai' }
  for (const q of ['', 'claude', 'claude opus 5.5', 'Opus', 'opus55', 'anthropic', 'claude-opus']) assert.equal(agentMatches(q, opus), true, q)
  for (const q of ['gpt6 astra', 'gpt-6', 'astra', 'openai gpt']) assert.equal(agentMatches(q, astra), true, q)
  assert.equal(agentMatches('gpt', opus), false)
  assert.equal(agentMatches('claude', astra), false)
  assert.equal(agentMatches('opus 6', opus), false)
})

test('a file named after Chinese punctuation is a mention all the way: the menu, the words, the chip, the send', () => {
  const q = queryAt('看，@cal', '看，@cal'.length)!
  assert.deepEqual(q, { start: 2, query: 'cal' })
  const out = insertMention('看，@cal', q.start, '看，@cal'.length, { path: 'calc.py', symbol: null })
  assert.equal(out.text, '看，@calc.py ')
  assert.deepEqual(mentionsOf(out.text), [{ path: 'calc.py', symbol: null }])
  assert.deepEqual(segments(out.text).map((s) => ('mention' in s ? s.raw : 'text' in s ? s.text : '?')), ['看，', '@calc.py', ' '])
  assert.deepEqual(mentionsOf('先看（@src/api.ts::load）再说：@README.md。'), [{ path: 'src/api.ts', symbol: 'load' }, { path: 'README.md', symbol: null }])
  assert.deepEqual(mentionsOf('mail a@b.com and x@y.py'), [])                       // inside a word: never
})

test('a number after @ in pasted notes is no file: "@400/500/1000", "@0.87" stay words; a path keeps its chip', () => {
  const text = 'fm @400/500/1000/1200/1470/2000 = 0.734，kill @0.87 然后看 @gan/report_11.md'
  assert.deepEqual(mentionsOf(text), [{ path: 'gan/report_11.md', symbol: null }])
})

test('a tool named with @ is a chip in the words: offered where it works, found by its name or what it goes by, no participant and no file', () => {
  const here = { computer: true }
  assert.deepEqual(toolsMatching('', here), [{ id: 'computer', label: 'Computer' }])
  for (const query of ['com', 'Computer', 'computer use', 'browser', '电脑']) assert.deepEqual(toolsMatching(query, here).map((t) => t.id), ['computer'], query)
  assert.deepEqual(toolsMatching('calc', here), [])
  assert.deepEqual(toolsMatching('com', {}), [])                                   // a plain browser holds no pages
  assert.deepEqual(toolsMatching('com', { computer: false }), [])
  const out = insertTool('请 @com 打开页面', 2, 6, { id: 'computer', label: 'Computer' })
  assert.equal(out.text, '请 @[Computer](tool:computer)  打开页面')
  assert.equal(out.caret, '请 @[Computer](tool:computer) '.length)
  assert.equal(queryAt(out.text, out.caret), null)                                  // right after the chip: no query
  const text = `${out.text} 看 @calc.py`
  assert.deepEqual(segments(text).map((s) => ('tool' in s ? `tool:${s.tool.tool}` : 'mention' in s ? `file:${s.mention.path}` : 'text')), ['text', 'tool:computer', 'text', 'file:calc.py'])
  assert.deepEqual(participantsOf(text), [])
  assert.deepEqual(mentionsOf(text), [{ path: 'calc.py', symbol: null }])
})
