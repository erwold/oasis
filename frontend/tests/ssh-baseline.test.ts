/** Baseline-compatible behavioral regressions: only imports present at e8274e6. */
import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
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
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
Object.assign(globalThis, { window: globalThis, __OASIS_CODE_BUILD__: 'test' })
const { useStore } = await import('../src/state/store.ts')
const { projectForFolder } = await import('../src/state/rail.ts')
const { Composer } = await import('../src/components/Composer.tsx')
const { WorkspaceBody } = await import('../src/components/Workspace.tsx')
const { renderToStaticMarkup } = await import('react-dom/server')
const { createElement } = await import('react')
const initial = { ...useStore.getState() }
const remote = { kind: 'ssh', target_id: 'host-a' }
const project = { id: 'remote-p', name: 'app', source_path: '/workspace/app', kind: 'direct', target: remote }
const session = { id: 'remote-s', project_id: project.id, workspace_id: 'remote-w', title: 'SSH', model: 'test', access_mode: 'full', target: remote, grants: { workspace_write: true, run_commands: true, network: true, attached_write: true }, runs: [], pending_approvals: [], roots: [], workspace: { id: 'remote-w', path: '/workspace/app', kind: 'direct', target: remote, branch: '', base_commit: '' } }
let writes: string[] = []
beforeEach(() => {
  useStore.setState({ ...initial, projects: [project] as never, session: session as never, composerTarget: 'agent', images: [], draft: 'keep me' })
  writes = []
  globalThis.fetch = (async (input, init) => { if (init?.method === 'POST') writes.push(String(input)); return new Response(JSON.stringify({ id: 'run', status: 'running', runs: [], roots: [] }), { status: 200 }) }) as typeof fetch
  for (const k of ['loadTree', 'loadCollab', 'refreshGate', 'loadSurfaces', 'loadInputs', 'loadTaskRuns', 'refreshEvidence', 'loadProjects', 'loadDirector', 'syncSession'] as const) useStore.setState({ [k]: async () => {} })
  useStore.setState({ watchRun: () => {} })
})
const render = (component: typeof WorkspaceBody | typeof Composer) => { Object.assign(useStore.getInitialState(), useStore.getState()); return renderToStaticMarkup(createElement(component)) }

test('local folder lookup never reuses a remote project with the same path', () => {
  assert.equal(projectForFolder([project] as never, '/workspace/app'), undefined)
})
test('remote composer explicitly disables local attachment placement', () => {
  const html = render(Composer)
  const button = html.match(/<button[^>]*data-testid="attach-images"[^>]*>/)?.[0]
  assert.ok(button)
  assert.match(button, /disabled=""/)
})
test('remote workspace displays its host identity in the existing workspace panel', () => {
  assert.match(render(WorkspaceBody), /host-a/)
})
test('remote without journal capability never promises that edits can be undone', () => {
  assert.doesNotMatch(render(WorkspaceBody), /can be undone run by run/)
})
test('unknown remote connection refuses send without local API fallback and keeps draft', async () => {
  await assert.rejects(useStore.getState().send('keep me'), /remote|SSH|Disconnected|Unknown/i)
  assert.deepEqual(writes, [])
  assert.equal(useStore.getState().draft, 'keep me')
})
