import assert from 'node:assert/strict'
import { beforeEach, test, mock } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import type { DirectorDetail, SessionDetail, Project, Run } from '../src/api/types.ts'
import type { PendingImage } from '../src/state/attachments.ts'

// The application is bundled by Vite; resolve only its extensionless TS imports for Node's store-level tests.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(candidate)) return next(candidate.href, context)
  }
  return next(specifier, context)
} })
const { useStore } = await import('../src/state/store.ts')
const { api, ApiError } = await import('../src/api/client.ts')
const initial = useStore.getState()
const session = (id = 's'): SessionDetail => ({ id, project_id: 'p', model: 'scripted:a', title: 'test', workspace: null, runs: [], director: null, interactions: [], relays: [], director_notes: [] } as unknown as SessionDetail)
const director = (transport: 'native' | 'bridge' = 'native', state = 'idle'): DirectorDetail => ({ session_id: 's', director: { id: 'd', session_id: 's', transport, state, model: 'scripted:a' }, turns: [], live: null, transports: [], pending_events: [] } as unknown as DirectorDetail)
const image = (): PendingImage => ({ id: 'image1', name: 'data.md', file: new File(['raw data'], 'data.md', { type: 'text/plain' }), url: '', state: 'ready', error: null, uploaded: null })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

// the per-session choice of where the words go lives in localStorage; node has none, so an in-memory one stands in
const stored = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => { stored.set(k, String(v)) }, removeItem: (k: string) => { stored.delete(k) }, clear: () => stored.clear() } })

beforeEach(() => {
  stored.clear()
  // these flows predate the one full-access confirmation (a new session runs with full access): the person gave it on
  // this machine before; the confirmation itself (asked once, Cancel sends nothing) is tests/access.test.ts's
  stored.set('oasis-code.notice.hideFullAccessWarning', '1')
  mock.restoreAll()
  useStore.setState({ ...initial, session: session(), composerTarget: 'director', images: [], draft: '', composers: {}, interactions: [], disposers: {}, childDisposers: {}, noteTo: 'director', noteInteractionId: null })
  for (const key of ['loadTree', 'refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'syncSession'] as const) useStore.setState({ [key]: async () => {} })
  mock.method(api, 'director', async () => ({ ...director(), director: null }))
})

test('default send without @ uses director/messages, carries the original envelope and never /chat', async () => {
  const body: unknown[] = []
  mock.method(api, 'sayToDirector', async (_sid: string, message: unknown) => { body.push(message); return { id: 'dt_1' } })
  const chat = mock.method(api, 'chat', async () => { throw new Error('wrong endpoint') })
  const text = '  Let Fable 5.1 battle on the existing experiments.\n'
  useStore.setState({ draft: text, thinking: 'xhigh' })
  await useStore.getState().send(text, { fresh: true, resumes_run_id: 'run_previous', budget: { max_requests: 8 } })
  assert.equal(chat.mock.callCount(), 0)
  assert.equal(body.length, 1)
  assert.deepEqual({ ...(body[0] as object), client_request_id: 'id' }, { text, thinking: 'xhigh', model: undefined, mentions: [], participant_thinking: {}, fresh: true, resumes_run_id: 'run_previous', budget: { max_requests: 8 }, attachments: [], client_request_id: 'id' })
  assert.equal(useStore.getState().draft, '')
})

test('hero captures × or default target through createSession and openSession, not just targetOf(null)', async () => {
  for (const target of ['agent', 'director'] as const) {
    useStore.setState({ ...initial, session: null, composerTarget: target, draft: 'first request', images: [], composers: {}, target: { kind: 'project', projectId: 'p', name: 'P', path: null }, projects: [{ id: 'p', name: 'P', kind: 'direct' } as Project] })
    for (const key of ['loadTree', 'refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'syncSession'] as const) useStore.setState({ [key]: async () => {} })
    mock.method(api, 'createSession', async () => session(`hero-${target}`))
    mock.method(api, 'session', async (id: string) => session(id))
    useStore.setState({ watchRun: () => {} })
    const agent = mock.method(api, 'chat', async () => ({ id: 'run_1', status: 'done' }) as Run)
    const routed = mock.method(api, 'sayToDirector', async () => ({ id: 'dt_1' }))
    await useStore.getState().startTask('first request')
    assert.equal(useStore.getState().composerTarget, target)
    assert.equal(agent.mock.callCount(), target === 'agent' ? 1 : 0)
    assert.equal(routed.mock.callCount(), target === 'director' ? 1 : 0)
    mock.restoreAll()
    mock.method(api, 'director', async () => ({ ...director(), director: null }))
  }
})

test('delayed loadDirector never reverses ×; reopening keeps the choice the session was given; without one it opens on its bridge, or the agent', async () => {
  const lookup = deferred<DirectorDetail>()
  mock.method(api, 'director', () => lookup.promise)
  const loading = useStore.getState().loadDirector()
  useStore.getState().setComposerTarget('agent')
  lookup.resolve(director('bridge'))
  await loading
  assert.equal(useStore.getState().composerTarget, 'agent')
  mock.method(api, 'session', async (id: string) => ({ ...session(id), director: director('bridge').director }))
  await useStore.getState().openSession('s')
  assert.equal(useStore.getState().composerTarget, 'agent')                 // the × of this session stays
  await useStore.getState().openSession('s2')
  assert.equal(useStore.getState().composerTarget, 'chatgpt')               // nothing chosen there: ChatGPT directs it
  mock.method(api, 'session', async (id: string) => session(id))
  mock.method(api, 'director', async () => ({ ...director(), director: null }))
  await useStore.getState().openSession('s3')
  assert.equal(useStore.getState().composerTarget, 'agent')                 // no director: the agent
  useStore.getState().setNoteTo('director')
  assert.equal(useStore.getState().composerTarget, 'director')              // called in: opened on the first message
  await useStore.getState().openSession('s')
  await useStore.getState().openSession('s3')
  assert.equal(useStore.getState().composerTarget, 'director')
  useStore.getState().closeSession()
  assert.equal(useStore.getState().composerTarget, 'agent')
})

test('a lookup from a previous opening cannot overwrite the same session after reopening', async () => {
  const old = deferred<DirectorDetail>()
  mock.method(api, 'director', () => old.promise)
  const loading = useStore.getState().loadDirector()
  useStore.getState().closeSession()
  mock.method(api, 'session', async () => session())
  mock.method(api, 'director', async () => director('native'))
  await useStore.getState().openSession('s')
  old.resolve(director('bridge'))
  await loading
  assert.equal(useStore.getState().director?.director?.transport, 'native')
})

test('active interaction remains director by default; explicit participant/everyone notes use only their queue', async () => {
  useStore.setState({ interactions: [{ id: 'ix', status: 'running' }] as never })
  const say = mock.method(api, 'sayToDirector', async () => ({ id: 'dt_1' }))
  const note = mock.method(api, 'noteInteraction', async (id: string) => ({ id, status: 'running' }))
  await useStore.getState().send('a follow-up')
  assert.equal(say.mock.callCount(), 1); assert.equal(note.mock.callCount(), 0)
  for (const to of ['everyone', 'pt_abcdef']) {
    useStore.getState().setNoteTo(to)
    await useStore.getState().send('the original note')
    assert.deepEqual(note.mock.calls.at(-1)?.arguments, ['ix', to, 'the original note'])
  }
  useStore.getState().setNoteTo('director')
  await useStore.getState().send('back to the director')
  assert.equal(say.mock.callCount(), 2)
  useStore.getState().setNoteTo('everyone')
  useStore.setState({ interactions: [{ id: 'new-ix', status: 'running' }] as never })
  // the group the note was for is gone: refused, the draft kept — not re-routed to the director (it was, before
  // 2026-10-16), nor to the group that replaced it
  await assert.rejects(useStore.getState().send('a note whose group is gone'), /no longer/)
  assert.equal(say.mock.callCount(), 2)
  assert.equal(note.mock.calls.filter((c) => c.arguments[0] === 'new-ix').length, 0)
})

test('attachments-only native send retries the envelope once, preserves failed drafts and reuses uploads and idempotency key', async () => {
  useStore.setState({ images: [image()], draft: '', thinking: 'max' })
  const upload = mock.method(api, 'uploadAttachment', async () => ({ asset_id: 'a1', name: 'data.md', media_type: 'text/plain' }))
  let attempts = 0
  const say = mock.method(api, 'sayToDirector', async () => { if (++attempts === 1) throw new Error('response lost'); return { id: 'dt_1' } })
  await assert.rejects(useStore.getState().send(''), /response lost/)
  assert.equal(useStore.getState().images.length, 1)
  await useStore.getState().send('')
  assert.equal(upload.mock.callCount(), 1)
  assert.deepEqual(say.mock.calls[0].arguments, say.mock.calls[1].arguments)
  assert.deepEqual((say.mock.calls[0].arguments[1] as { attachments: string[] }).attachments, ['a1'])
  assert.equal(useStore.getState().images.length, 0)
})

test('paused/closed director, bridge attachment and unavailable route refuse without replacing the director or losing the draft', async () => {
  const agent = mock.method(api, 'chat', async () => { throw new Error('wrong endpoint') })
  const open = mock.method(api, 'openDirector', async () => { throw new Error('must not replace director') })
  const upload = mock.method(api, 'uploadAttachment', async () => { throw new Error('should not upload') })
  for (const state of ['paused', 'closed']) {
    useStore.setState({ director: director('native', state), images: [image()], draft: 'keep me' })
    await assert.rejects(useStore.getState().send('keep me'), new RegExp(state))
  }
  useStore.setState({ director: director('bridge'), composerTarget: 'chatgpt' })
  await assert.rejects(useStore.getState().send('keep me'), /entire draft is kept/)
  assert.equal(upload.mock.callCount(), 0)
  useStore.setState({ director: null, images: [], composerTarget: 'director' })
  mock.method(api, 'sayToDirector', async () => { throw new ApiError(409, 'route unavailable', null) })
  await assert.rejects(useStore.getState().send('keep me'), /route unavailable/)
  assert.equal(useStore.getState().draft, 'keep me')
  assert.equal(useStore.getState().composerTarget, 'director')
  assert.equal(agent.mock.callCount(), 0); assert.equal(open.mock.callCount(), 0)
})

test('an accepted send clears only its own unchanged draft; a new draft written during the send is kept', async () => {
  const reply = deferred<never>()
  mock.method(api, 'sayToDirector', () => reply.promise)
  useStore.setState({ draft: 'first' })
  const sending = useStore.getState().send('first')
  await Promise.resolve()
  useStore.getState().setDraft('next')
  reply.resolve({ id: 'dt_1' } as never)
  await sending
  assert.equal(useStore.getState().draft, 'next')
})

test('source-mounted output refuses adoption before calling the write endpoint', async () => {
  useStore.setState({ interactions: [{ id: 'ix', status: 'done', workspace_policy: 'isolated', base_checkpoint_id: null, nodes: [{ id: 'a1', status: 'done', run_id: 'run_1', workspace_id: 'ws_1' }] }] as never })
  const read = mock.method(api, 'workspace', async () => ({ id: 'ws_1', source_mount: { root: '/fixture/source', name: 'source', readonly: true } }))
  const write = mock.method(api, 'adoptNode', async () => { throw new Error('unsafe write') })
  await assert.rejects(useStore.getState().adoptNode('ix', 'a1'), /source is read-only/)
  assert.equal(read.mock.callCount(), 1)
  assert.equal(write.mock.callCount(), 0)
})

// API boundary regression: /chat does not add the unrelated legacy director:true flag.
test('/chat remains an explicit agent request with a Run response', async () => {
  mock.restoreAll()
  let sent: Record<string, unknown> | null = null
  mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return Response.json({ id: 'run_1', status: 'done' }) })
  await api.chat('s', { text: 'agent only' })
  assert.deepEqual(sent, { text: 'agent only' })
})


test('hero creation is owned by the captured start draft even when B is opened before creation finishes', async () => {
  const creating = deferred<SessionDetail>()
  const aImage = image(), bImage = { ...image(), id: 'B-image', name: 'B.md' }
  useStore.setState({ session: null, draft: '  A original\n', images: [aImage], modelChoice: 'route-A', thinking: 'xhigh', target: { kind: 'project', projectId: 'p', name: 'P', path: null }, projects: [{ id: 'p', kind: 'direct' } as Project] })
  const create = mock.method(api, 'createSession', () => creating.promise)
  mock.method(api, 'session', async (id: string) => session(id))
  const upload = mock.method(api, 'uploadAttachment', async () => ({ asset_id: 'a-asset', name: 'data.md', media_type: 'text/plain' }))
  const message = mock.method(api, 'sayToDirector', async () => { throw new Error('A response lost') })
  const starting = useStore.getState().startTask('  A original\n')
  await useStore.getState().openSession('B')
  useStore.setState({ draft: 'B stays here', images: [bImage], modelChoice: 'route-B', thinking: 'low' })
  creating.resolve(session('A'))
  await assert.rejects(starting, /A response lost/)
  assert.equal(useStore.getState().session?.id, 'B')
  assert.equal(useStore.getState().draft, 'B stays here')
  assert.deepEqual(useStore.getState().images, [bImage])
  assert.equal(useStore.getState().modelChoice, 'route-B')
  assert.equal(useStore.getState().thinking, 'low')
  assert.equal(useStore.getState().composers.A.draft, '  A original\n')
  assert.equal(useStore.getState().composers.A.images[0].id, aImage.id)
  assert.equal(useStore.getState().composers.start.draft, '')
  assert.equal((create.mock.calls[0].arguments[1] as { model: string }).model, 'route-A')
  assert.equal(upload.mock.calls[0].arguments[0], 'A')
  assert.equal(message.mock.calls[0].arguments[0], 'A')
  assert.equal((message.mock.calls[0].arguments[1] as { thinking: string }).thinking, 'xhigh')
})

test('A accepted with response lost, B succeeds, then retry A keeps the original request id', async () => {
  mock.method(api, 'session', async (id: string) => session(id))
  let aAttempts = 0
  const sent = mock.method(api, 'sayToDirector', async (sid: string) => {
    if (sid === 'A-retry' && ++aAttempts === 1) throw new Error('accepted but response lost')
    return { id: 'dt-stable' }
  })
  await useStore.getState().openSession('A-retry')
  useStore.getState().setNoteTo('director')
  useStore.setState({ draft: 'A request' })
  await assert.rejects(useStore.getState().send('A request'), /response lost/)
  await useStore.getState().openSession('B-retry')
  useStore.getState().setNoteTo('director')
  useStore.setState({ draft: 'B request' })
  await useStore.getState().send('B request')
  await useStore.getState().openSession('A-retry')
  assert.equal(useStore.getState().draft, 'A request')
  await useStore.getState().send('A request')
  assert.deepEqual(sent.mock.calls[0].arguments, sent.mock.calls[2].arguments)
  assert.notEqual((sent.mock.calls[0].arguments[1] as { client_request_id: string }).client_request_id, (sent.mock.calls[1].arguments[1] as { client_request_id: string }).client_request_id)
})

test('queued note acknowledgement preserves new typing and clears only its origin after switching sessions', async () => {
  for (const switchSession of [false, true]) {
    const queued = deferred<never>()
    mock.method(api, 'noteInteraction', () => queued.promise)
    mock.method(api, 'session', async (id: string) => session(id))
    await useStore.getState().openSession('notes-A')
    useStore.setState({ draft: '  original note\n', interactions: [{ id: 'ix-notes', status: 'running' }] as never })
    const sending = useStore.getState().noteInteraction('ix-notes', 'everyone', '  original note\n')
    if (switchSession) await useStore.getState().openSession('notes-B')
    useStore.getState().setDraft('new typing stays')
    queued.resolve({ id: 'ix-notes', status: 'running' } as never)
    await sending
    assert.equal(useStore.getState().draft, 'new typing stays')
    if (switchSession) assert.equal(useStore.getState().composers['notes-A'].draft, '')
  }
})

test('bridge setup targets A through both delayed close and delayed desktop handshake, never B', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window') })
  for (const pauseAt of ['close', 'body']) {
    const close = deferred<{ closed: boolean }>()
    const bridge = deferred<{ url: string; token: string }>()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { oasisCodeDesktop: { openChatGptBridge: () => bridge.promise, chatGptStatus: async () => null } } })
    useStore.setState({ session: session('bridge-A'), director: director(), directorDisposer: null })
    mock.method(api, 'closeDirector', () => close.promise)
    mock.method(api, 'session', async (id: string) => session(id))
    const open = mock.method(api, 'openDirector', async () => director('bridge'))
    const change = useStore.getState().directWithChatGpt()
    if (pauseAt === 'body') { close.resolve({ closed: true }); await Promise.resolve(); await Promise.resolve() }
    await useStore.getState().openSession('bridge-B')
    const bDisposer = mock.fn()
    useStore.setState({ director: director(), directorDisposer: bDisposer, draft: 'B draft' })
    close.resolve({ closed: true }); bridge.resolve({ url: 'http://127.0.0.1:9999', token: 'fixture' })
    await change
    assert.equal(open.mock.calls.at(-1)?.arguments[0], 'bridge-A')
    assert.equal(useStore.getState().session?.id, 'bridge-B')
    assert.equal(useStore.getState().director?.director?.transport, 'native')
    assert.equal(useStore.getState().draft, 'B draft')
    assert.equal(bDisposer.mock.callCount(), 0)
    mock.restoreAll()
    mock.method(api, 'director', async () => ({ ...director(), director: null }))
  }
})

test('closeDirector completion cannot dispose a stream belonging to a different opening', async () => {
  const closing = deferred<{ closed: boolean }>()
  mock.method(api, 'closeDirector', () => closing.promise)
  mock.method(api, 'session', async (id: string) => session(id))
  const promise = useStore.getState().closeDirector()
  await useStore.getState().openSession('close-B')
  const disposer = mock.fn()
  useStore.setState({ directorDisposer: disposer, director: director('bridge') })
  closing.resolve({ closed: true }); await promise
  assert.equal(disposer.mock.callCount(), 0)
  assert.equal(useStore.getState().director?.director?.transport, 'bridge')
})

test('attachRefused retries the original text without trimming it', async () => {
  const text = '  original material\n'
  useStore.setState({ draft: text, target: { kind: 'folder', path: '/fixture/source' }, importRefusal: {} as never })
  const start = mock.fn(async (_text: string) => {})
  useStore.setState({ startTask: start })
  await useStore.getState().attachRefused()
  assert.equal(start.mock.calls[0].arguments[0], text)
})

for (const route of ['native', 'bridge'] as const) test(`late ${route} handshake updates record but never reverses a newer explicit ×`, async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window') })
  const handshake = deferred<DirectorDetail>()
  const entered = deferred<void>()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { oasisCodeDesktop: { openChatGptBridge: async () => ({ url: 'http://127.0.0.1:1', token: 'fixture' }), chatGptStatus: async () => null } } })
  mock.method(api, 'openDirector', () => { entered.resolve(); return handshake.promise })
  const opening = route === 'native' ? useStore.getState().openDirector({ transport: 'native', model: 'scripted:a', config: {} }) : useStore.getState().directWithChatGpt()
  await entered.promise
  useStore.getState().setComposerTarget('agent')
  handshake.resolve(director(route))
  await opening
  assert.equal(useStore.getState().composerTarget, 'agent')
  assert.equal(useStore.getState().director?.director?.transport, route)
})

for (const target of ['director', 'agent'] as const) test(`hero ${target} send freezes attachments before exposed session's delayed refresh; next draft survives`, async () => {
  const refresh = deferred<void>(), exposed = deferred<void>()
  const first = image(), next = { ...image(), id: 'next-draft', file: new File(['next'], 'next.txt'), name: 'next.txt' }
  useStore.setState({ session: null, composerTarget: target, draft: 'original', images: [first], target: { kind: 'project', projectId: 'p', name: 'P', path: null }, projects: [{ id: 'p', kind: 'direct' } as Project], watchRun: () => {} })
  mock.method(api, 'createSession', async () => session(`frozen-${target}`))
  mock.method(api, 'session', async (id: string) => session(id))
  useStore.setState({ refreshEvidence: async () => { exposed.resolve(); await refresh.promise } })
  const uploads = mock.method(api, 'uploadAttachment', async () => ({ asset_id: 'original-asset', name: 'data.md', media_type: 'text/plain' }))
  const say = mock.method(api, 'sayToDirector', async () => ({ id: 'dt-original' }))
  const chat = mock.method(api, 'chat', async () => ({ id: 'run-original', status: 'done' } as Run))
  const sending = useStore.getState().startTask('original')
  await exposed.promise
  assert.equal(useStore.getState().session?.id, `frozen-${target}`)
  useStore.getState().removeImage(first.id)
  useStore.setState({ images: [next] })
  useStore.getState().setDraft('original') // even identical new words belong to a newer draft revision
  refresh.resolve()
  await sending
  const message = (target === 'director' ? say : chat).mock.calls[0].arguments[1] as { text: string; attachments: string[] }
  assert.equal(message.text, 'original')
  assert.deepEqual(message.attachments, ['original-asset'])
  assert.equal(uploads.mock.calls[0].arguments[1], first.file)
  assert.equal(uploads.mock.callCount(), 1)
  assert.deepEqual(useStore.getState().images, [next])
  assert.equal(useStore.getState().draft, 'original')
})

test("the director's model: one picked before it opens is the model it opens on, before the words; an open one is changed in place", async () => {
  const calls: string[] = []
  mock.method(api, 'openDirector', async (_sid: string, body: { model: string }) => { calls.push(`open:${body.model}`); return { ...director(), director: { ...director().director!, model: body.model } } })
  mock.method(api, 'sayToDirector', async () => { calls.push('say'); return { id: 'dt_1' } })
  useStore.setState({ session: session(), composerTarget: 'director', director: null })
  await useStore.getState().setDirectorModel('route-fable')
  assert.equal(useStore.getState().directorModel, 'route-fable')
  useStore.setState({ draft: 'battle it' })
  await useStore.getState().send('battle it')
  assert.deepEqual(calls, ['open:route-fable', 'say'])
  // open: the pick changes the director itself
  const updates: unknown[] = []
  mock.method(api, 'updateDirector', async (_sid: string, body: unknown) => { updates.push(body); return director() })
  useStore.setState({ director: director(), session: { ...session(), director: director().director } as never })
  await useStore.getState().setDirectorModel('route-opus')
  assert.deepEqual(updates, [{ model: 'route-opus' }])
})
