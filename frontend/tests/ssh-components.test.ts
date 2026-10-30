import assert from 'node:assert/strict'
import { beforeEach, afterEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import type { SshTarget, PortForward } from '../src/api/ssh.ts'
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/frontend/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of ['.ts', '.tsx']) { const u = new URL(`${specifier}${ext}`, context.parentURL); if (existsSync(u)) return next(u.href, context) }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\.(css|png|svg)$/.test(url)) return { format: 'module', source: `export default ${JSON.stringify(url)}`, shortCircuit: true }
    if (url.startsWith('file:') && url.endsWith('.tsx')) return { format: 'module', source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText, shortCircuit: true }
    return next(url, context)
  },
})
// No browser, SSH, app or sockets: real React DOM events over an in-memory DOM and mocked HTTP/IPC.
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://ui.invalid/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true, __OASIS_CODE_BUILD__: 'test' })
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: dom.window.localStorage })
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { useStore } = await import('../src/state/store.ts')
const { useSsh, forwardUrl, openForward } = await import('../src/state/ssh.ts')
const { resourceTarget, sessionTarget } = await import('../src/api/ssh.ts')
const { projectForFolder } = await import('../src/state/rail.ts')
const { useDesk } = await import('../src/state/desk.ts')
const { SshPorts, SshConnection } = await import('../src/components/SshTarget.tsx')
const { SshAsks } = await import('../src/components/SshAsks.tsx')
const { UiInputBlock, HarnessAsks } = await import('../src/components/UiInput.tsx')
const { FolderDialog } = await import('../src/components/FolderDialog.tsx')
const { AccessChip } = await import('../src/components/AccessChip.tsx')
const { WorkspaceBody } = await import('../src/components/Workspace.tsx')
const { Desk } = await import('../src/components/Desk.tsx')
const initial = { ...useStore.getState() }
const sshInitial = { ...useSsh.getState() }
const deskInitial = { ...useDesk.getState() }
const remote = { kind: 'ssh' as const, target_id: 'a' }
const makeHost = (id = 'a'): SshTarget => ({ id, label: `Host ${id}`, destination: `dev-${id}`, port: null, state: 'ready', generation: 'g1', capabilities: { direct_files: true, journal_undo: true, port_forwarding: true, sandbox: false, isolated_copies: false }, last_error: null, created_at: '' })
const project = { id: 'p', name: 'app', source_path: '/workspace/app', kind: 'direct', target: remote }
const session = { id: 's', project_id: 'p', title: 'Task', target: remote, access_mode: 'full', workspace_id: 'w', workspace: { id: 'w', path: '/workspace/app', kind: 'direct', target: remote, branch: '', base_commit: '' }, grants: { workspace_write: true, run_commands: true, network: true, attached_write: true }, pending_approvals: [], active_children: [], runs: [], roots: [] }
const forward: PortForward = { id: 'f', target_id: 'a', workspace_id: 'w', remote_host: '127.0.0.1', remote_port: 3000, local_host: '127.0.0.1', local_port: 48123, local_url: 'http://127.0.0.1:48123', state: 'ready' }
interface Call { path: string; method: string; body: Record<string, unknown> }
type Reply = { body: unknown; status?: number }
let calls: Call[] = [], hosts: SshTarget[] = [], rows: PortForward[] = []
let handler: (c: Call) => Reply | Promise<Reply> | undefined = () => undefined
let root: ReturnType<typeof createRoot>
const container = document.getElementById('root')!
let navigations: unknown[] = []
const bridge = { placeBrowser: () => {}, browserTab: async (x: unknown) => { navigations.push(x); return { ok: true } }, browserNavigate: async () => ({ ok: true }), pickBrowserElement: async () => null, cancelBrowserPick: async () => true, browserStatus: async () => null }
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
const mount = async (element: Parameters<typeof root.render>[0]) => { await act(async () => root.render(element)); await flush() }
function button(text: string): HTMLButtonElement { const b = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text); assert.ok(b, text); return b }
const click = async (b: HTMLElement) => { await act(async () => b.click()); await flush() }
const list = (path: string) => ({ path, name: path.split('/').pop(), parent: '/', entries: [], favorites: [], truncated: false })
beforeEach(() => {
  hosts = [makeHost(), makeHost('b')]; rows = []; calls = []; navigations = []; handler = () => undefined
  Object.assign(dom.window, { oasisCodeDesktop: bridge })
  useStore.setState({ ...initial, session: session as never, projects: [project] as never, composerTarget: 'agent', draft: 'keep', images: [] })
  useSsh.setState({ ...sshInitial, targets: hosts })
  useDesk.setState({ ...deskInitial })
  root = createRoot(container)
  globalThis.fetch = (async (url, init) => {
    const c = { path: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {} }; calls.push(c)
    let reply = await handler(c)
    if (!reply && c.path === '/api/ssh/targets') reply = { body: hosts }
    if (!reply && c.path.endsWith('/forwards')) reply = { body: rows }
    return new Response(JSON.stringify(reply?.body ?? { detail: 'not found' }), { status: reply?.status ?? (reply ? 200 : 404), headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
})
afterEach(async () => { await act(async () => root.unmount()); await flush() })

test('the folder dialog lists this machine\'s folders only: a folder on an SSH host is opened by an agent', async () => {
  handler = (c) => c.path.startsWith('/api/fs/dirs') ? { body: list('/Users/me') } : undefined
  await mount(createElement(FolderDialog, { open: true, onClose: () => {}, onPick: () => {} }))
  assert.ok(calls.some((c) => c.path.startsWith('/api/fs/dirs')))
  assert.ok(!calls.some((c) => c.path.startsWith('/api/ssh/')))
  assert.equal(container.querySelector('input'), null)
})

test("an agent's SSH question waits over the composer, not in the thread: what the yes connects (a new host's key open), Connect sends the yes, Cancel declines; the thread keeps the answer", async () => {
  const record = { id: 'in_1', session_id: 's', run_id: 'r', tool_call_id: 't', status: 'pending', values: null, closed_reason: null, created_at: '2026-10-17T00:00:00.000Z', updated_at: '2026-10-17T00:00:00.000Z',
    request: { harness: 'ssh_connect', title: 'Connect to GPU?', message: 'root@gpu:2222\nkey ~/.ssh/id\nnew host key SHA256:abc ED25519', root: 'connect', elements: { connect: { type: 'select', props: { label: 'Connect', key: 'connect', options: [{ label: 'Connect', value: 'yes' }] } } }, initial_state: { connect: 'yes' }, required: ['connect'] } }
  // waiting: nothing in the thread
  await mount(createElement(UiInputBlock, { record: record as never }))
  assert.equal(container.querySelector('[data-testid="ssh-connect-ask"]'), null)
  await act(async () => root.unmount()); root = createRoot(container)
  // the capsule: the host, the key file, the new key open under it
  handler = (c) => c.path.endsWith('/submit') ? { body: { input: { ...record, status: 'submitted', values: { connect: 'yes' }, updated_at: '2026-10-17T00:00:01.000Z' } } } : undefined
  useStore.setState({ uiInputs: { in_1: record as never }, replaying: false })
  await mount(createElement(HarnessAsks))
  const cap = container.querySelector('[data-testid="ssh-connect-capsule"]')!
  assert.match(cap.querySelector('.ask-cap-head')!.textContent ?? '', /^Connect root@gpu:2222/)
  assert.equal(cap.classList.contains('open'), true)
  assert.deepEqual([...cap.querySelectorAll('.ask-cap-row')].map((r) => r.textContent), ['New ED25519 host keySHA256:abc', 'Key file~/.ssh/id', 'NameGPU'])
  await click(container.querySelector('[data-testid="ssh-connect-allow"]')!)
  const sent = calls.find((c) => c.path.endsWith('/ui-inputs/in_1/submit'))!
  assert.equal(sent.method, 'POST')
  assert.deepEqual(sent.body.values, { connect: 'yes' })
  await act(async () => root.unmount()); root = createRoot(container)
  // answered: the thread says so
  await mount(createElement(UiInputBlock, { record: { ...record, status: 'submitted', values: { connect: 'yes' }, updated_at: '2026-10-17T00:00:01.000Z' } as never }))
  assert.equal(container.querySelector('[data-testid="ssh-connect-answer"]')!.textContent, 'Connect')
  await act(async () => root.unmount()); root = createRoot(container)
  // Cancel: the question is dismissed
  handler = (c) => c.path.endsWith('/dismiss') ? { body: { input: { ...record, id: 'in_2', status: 'dismissed', updated_at: '2026-10-17T00:00:01.000Z' } } } : undefined
  useStore.setState({ uiInputs: { in_2: { ...record, id: 'in_2' } as never } })
  await mount(createElement(HarnessAsks))
  await click(container.querySelector('[data-testid="ssh-connect-decline"]')!)
  assert.ok(calls.some((c) => c.path.endsWith('/ui-inputs/in_2/dismiss')))
  useStore.setState({ uiInputs: {} })
})

test("a connector's SSH question is a capsule over the composer: a new host's keys shown first (ED25519 on top), Connect answers it, Connected a moment, then it goes", async () => {
  const ask = { id: 'sshask_1', from: 'ChatGPT', title: 'Connect to a long name · box?', status: 'pending', error: null,
    lines: ['root@box:2222', 'new host key SHA256:rsa0 RSA', 'new host key SHA256:ed25519x ED25519', 'new host key SHA256:ecdsa0 ECDSA'] }
  let open = [ask]
  handler = (c) => {
    if (c.path === '/api/ssh/asks') return { body: open }
    if (c.path === '/api/ssh/asks/sshask_1/answer') { open = []; return { body: { ...ask, status: 'connected' } } }
  }
  await mount(createElement(SshAsks))
  const card = container.querySelector('[data-testid="ssh-ask"]')!
  assert.match(card.querySelector('.ask-cap-head')!.textContent ?? '', /^Connect root@box:2222ChatGPT/)
  // never trusted before: open on the keys, the one people compare first; the asker's long name below them
  assert.equal(card.classList.contains('open'), true)
  assert.deepEqual([...card.querySelectorAll('[data-testid="ssh-ask-key"]')].map((r) => r.textContent), ['New ED25519 host keySHA256:ed25519x', 'New ECDSA host keySHA256:ecdsa0', 'New RSA host keySHA256:rsa0'])
  assert.match(card.textContent ?? '', /Namea long name · box/)
  await click(button('Connect'))
  assert.deepEqual(calls.find((c) => c.path === '/api/ssh/asks/sshask_1/answer')!.body, { connect: true })
  const done = container.querySelector('[data-testid="ssh-ask"]')!
  assert.equal(done.getAttribute('data-state'), 'answered')
  assert.match(done.textContent ?? '', /Connected/)
  await act(async () => { await new Promise((r) => setTimeout(r, 1300)) })
  assert.equal(container.querySelector('[data-testid="ssh-ask"]'), null)
})

test('a reconnect to a host already trusted stays one line until opened; the chevron opens and closes it', async () => {
  const ask = { id: 'sshask_2', from: 'ChatGPT', title: 'Reconnect to box?', lines: ['root@box'], status: 'pending', error: null }
  handler = (c) => (c.path === '/api/ssh/asks' ? { body: [ask] } : undefined)
  await mount(createElement(SshAsks))
  const card = container.querySelector('[data-testid="ssh-ask"]')!
  assert.match(card.querySelector('.ask-cap-head')!.textContent ?? '', /^Reconnect root@box/)
  assert.equal(card.classList.contains('open'), false)
  await click(container.querySelector('[data-testid="ssh-ask-toggle"]')!)
  assert.equal(container.querySelector('[data-testid="ssh-ask"]')!.classList.contains('open'), true)
  await click(container.querySelector('[data-testid="ssh-ask-toggle"]')!)
  assert.equal(container.querySelector('[data-testid="ssh-ask"]')!.classList.contains('open'), false)
})

test('Reconnect acts only on the selected SSH target, not gateway or SSE', async () => {
  hosts[0] = { ...makeHost(), state: 'disconnected' }; useSsh.setState({ targets: hosts })
  handler = (c) => c.path.endsWith('/a/connect') ? { body: makeHost() } : undefined
  await mount(createElement(SshConnection, { target: remote }))
  await click(button('Reconnect'))
  assert.match(container.textContent!, /Connected/)
  assert.deepEqual(calls.filter((c) => c.method === 'POST').map((c) => c.path), ['/api/ssh/targets/a/connect'])
})

test('Ports lists the forwards an agent opened, with no port form; Open in browser opens the existing real Browser card, not external URL', async () => {
  await mount(createElement(SshPorts))
  assert.equal(container.querySelector('[data-testid="ssh-ports"]'), null)             // nothing forwarded: no section
  await act(async () => root.unmount()); root = createRoot(container)
  rows = [forward]
  await mount(createElement(SshPorts))
  assert.equal(container.querySelectorAll('[data-testid="ssh-port"]').length, 1)
  assert.equal(container.querySelector('input'), null)
  await click(button('Open in browser'))
  assert.deepEqual(navigations, [{ action: 'new', url: 'http://127.0.0.1:48123/' }])
  assert.equal(useSsh.getState().preview?.session_id, 's')
  assert.equal(useDesk.getState().windows.browser?.kind, 'browser')
  assert.equal(useDesk.getState().windows.browser?.min, false)
  Object.assign(useStore.getInitialState(), useStore.getState()); Object.assign(useSsh.getInitialState(), useSsh.getState()); Object.assign(useDesk.getInitialState(), useDesk.getState())
  const html = renderToStaticMarkup(createElement(Desk))
  assert.match(html, /data-testid="card-browser"/)
  assert.match(html, /data-testid="browser-page"/)
})

test('Ports filters another workspace, and disconnected targets cannot open stale forwards', async () => {
  rows = [forward, { ...forward, id: 'foreign', workspace_id: 'other', remote_port: 4000 }]
  await mount(createElement(SshPorts))
  assert.equal(container.querySelectorAll('[data-testid="ssh-port"]').length, 1)
  hosts[0] = { ...makeHost(), state: 'disconnected' }
  await act(async () => useSsh.setState({ targets: hosts }))
  await assert.rejects(openForward(forward, 's', () => true, { oasisCodeDesktop: bridge }), /Disconnected/)
  assert.deepEqual(navigations, [])
})

test('forward validates target/workspace/origin/port and does not navigate after session switch', async () => {
  for (const bad of [{ ...forward, workspace_id: 'other' }, { ...forward, target_id: 'b' }, { ...forward, local_url: 'http://127.0.0.1:8321/' }, { ...forward, local_url: 'https://example.com/' }, { ...forward, local_url: `${forward.local_url}/?token=x` }]) assert.throws(() => forwardUrl(bad, 'a', 'w'))
  rows = [forward]
  await openForward(forward, 's', () => false, { oasisCodeDesktop: bridge })
  assert.deepEqual(navigations, [])
})

test('a remote session shows no access chip (Full is its only access) and is never set to Sandbox; capability-enabled journal undo is available, and missing capability refuses it', async () => {
  await mount(createElement(AccessChip))
  assert.equal(container.querySelector('[data-testid="access-chip"]'), null)
  assert.equal(await useStore.getState().chooseAccess('sandbox'), false)
  assert.ok(!calls.some((c) => c.method === 'PUT'))
  useStore.setState({ refreshEvidence: async () => {} })
  handler = (c) => c.path === '/api/runs/run/undo' ? { body: { restored: ['a'], removed: [], conflicts: [], nothing: false } } : undefined
  await useStore.getState().undoRun('run')
  assert.equal(calls.filter((c) => c.path.endsWith('/undo')).length, 1)
  useSsh.setState({ targets: [{ ...makeHost(), capabilities: { ...makeHost().capabilities, journal_undo: false } }] })
  await assert.rejects(useStore.getState().undoRun('run'), /Unsupported/)
  assert.equal(calls.filter((c) => c.path.endsWith('/undo')).length, 1)
})

test('persisted targets are isolated, malformed/conflicting targets never become local', () => {
  const b = { ...project, id: 'pb', target: { kind: 'ssh' as const, target_id: 'b' } }
  assert.equal(projectForFolder([project, b] as never, project.source_path, 'direct', remote)?.id, 'p')
  assert.equal(projectForFolder([project, b] as never, project.source_path, 'direct', b.target)?.id, 'pb')
  assert.equal(resourceTarget({ target: {} }).kind, 'unknown')
  assert.equal(sessionTarget({ ...session, workspace: { ...session.workspace, target: b.target } }, [project]).kind, 'unknown')
  assert.deepEqual(sessionTarget({ project_id: 'p', workspace: session.workspace }, [project]), remote)
})

test('the remote workspace card names the host and folder once, with no explanation; the attachment handler refuses without requests', async () => {
  Object.assign(useStore.getInitialState(), useStore.getState()); Object.assign(useSsh.getInitialState(), useSsh.getState())
  const card = renderToStaticMarkup(createElement(WorkspaceBody))
  // once in what the card shows (its tooltip, which holds the same words whole where the line is cut, is not shown)
  assert.equal(card.replace(/ title="[^"]*"/g, '').split('SSH · Host a · /workspace/app').length - 1, 1)
  assert.doesNotMatch(card, /Editing in place|can be undone run by run/)
  useStore.getState().addImages([new File(['x'], 'a.txt', { type: 'text/plain' })])
  assert.equal(useStore.getState().images.length, 0)
  await assert.rejects(useStore.getState().sendSeparate('keep'), /Unsupported/)
  assert.equal(calls.length, 0)
  assert.equal(useStore.getState().draft, 'keep')
})

test('a workspace with conflicting target and remote binding is unknown, not local or another host', () => {
  assert.equal(resourceTarget({ target: { kind: 'local' }, remote: { target_id: 'a' } }).kind, 'unknown')
  assert.equal(resourceTarget({ target: remote, remote: { target_id: 'b' } }).kind, 'unknown')
  assert.deepEqual(resourceTarget({ target: remote, remote: { target_id: 'a' } }), remote)
})

test('new SSH task creates a target-bound direct project rather than reusing the local path, and sends to its fixed session', async () => {
  useStore.setState({ session: null, target: { kind: 'folder', path: '/workspace/app', target: remote }, projects: [{ ...project, id: 'local-p', target: { kind: 'local' } }] as never })
  for (const key of ['loadTree', 'loadCollab', 'refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'loadDirector', 'syncSession'] as const) useStore.setState({ [key]: async () => {} })
  useStore.setState({ watchRun: () => {} })
  handler = (c) => {
    if (c.path === '/api/projects' && c.method === 'POST') return { body: project }
    if (c.path === '/api/projects/p/sessions' || c.path === '/api/sessions/s') return { body: { ...session, target: undefined } }
    if (c.path === '/api/sessions/s/chat') return { body: { id: 'run', status: 'running' } }
  }
  await useStore.getState().startTask('keep')
  const projectCall = calls.find((c) => c.path === '/api/projects' && c.method === 'POST')!
  assert.deepEqual(projectCall.body.target, remote)
  assert.equal(projectCall.body.mode, 'direct')
  assert.equal(projectCall.body.source_path, '/workspace/app')
  assert.ok(calls.some((c) => c.path === '/api/sessions/s/chat'))
  assert.ok(!calls.some((c) => c.path.includes('local-p') || c.path.startsWith('/api/fs/')))
  assert.deepEqual(sessionTarget(useStore.getState().session, useStore.getState().projects), remote)
})

test('SSH project response missing its target is refused before session creation, and draft stays intact', async () => {
  useStore.setState({ session: null, target: { kind: 'folder', path: '/workspace/app', target: remote }, projects: [] })
  useStore.setState({ loadProjects: async () => {} })
  handler = (c) => c.path === '/api/projects' && c.method === 'POST' ? { body: { ...project, target: undefined } } : undefined
  await assert.rejects(useStore.getState().startTask('keep'), /Unknown target/)
  assert.equal(useStore.getState().draft, 'keep')
  assert.ok(!calls.some((c) => c.path.endsWith('/sessions') || c.path.endsWith('/chat')))
})

test('selected SSH project cannot become local when a refreshed project record loses its target', async () => {
  useStore.setState({ session: null, target: { kind: 'project', projectId: 'p', name: 'app', path: '/workspace/app', target: remote }, projects: [{ ...project, target: undefined }] as never })
  await useStore.getState().startTask('keep').catch(() => {})
  assert.deepEqual(calls, [])
  assert.equal(useStore.getState().draft, 'keep')
})
