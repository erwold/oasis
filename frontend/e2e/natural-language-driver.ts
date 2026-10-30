import assert from 'node:assert/strict'
import type { Page, Request } from 'playwright-core'
import type { InteractionDetail, Run, WorkspaceDetail } from '@oasis-code/contract'

/** Scripted fixture inputs, not instructions injected into participants. The backend native-director fixture must
 * recognize these from its model request and invoke the real connector/InteractionManager. No @ or plan payload. */
export const NATURAL_WORDS = {
  battle: '让 Fable 5.1 在我的 research backup 目录下，根据现有实验数据，结合数学理论推导，battle 出纯 GAN 稳定训练的方法。',
  independent: '让多个 agent 根据现有实验数据给出独立候选，先由我选择。',
  slow: '让三个 agent battle，包含慢节点，先独立回答再交叉讨论。',
  followup: '补充：不要修改研究源。',
} as const
export const FABLE_FIXTURE_ROUTE = 'anthropic:claude-fable-5-1'
export type NaturalInteraction = InteractionDetail & { workspace_policy: 'legacy' | 'isolated'; source_turn_id: string | null }
export type MountedWorkspace = WorkspaceDetail & { source_mount: { root: string; name: string; readonly: true } | null }

export async function pageApi<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
    return response.json()
  }, { path, body }) as Promise<T>
}
/** The Agent Teams dock out of the shelf (a session opens with it put away). */
export async function showTeams(page: Page): Promise<void> {
  if (await page.locator('[data-testid="graph-dock"]').count()) return
  await page.click('[data-testid="desk-shelf"]')
  await page.click('.desk-tail-list .desk-chip:has-text("Agent Teams")')
  await page.waitForSelector('[data-testid="graph-dock"]')
}

export async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, label: string, timeout = 60_000): Promise<T> {
  const until = Date.now() + timeout
  let latest: T | undefined
  while (Date.now() < until) {
    latest = await read()
    if (ok(latest)) return latest
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`${label}: ${JSON.stringify(latest)}`)
}
export async function chooseNaturalSource(page: Page, path: string): Promise<void> {
  await page.click('[data-testid="folder-chip"]')
  await page.waitForSelector('[data-testid="folder-dialog"][open]')
  await page.click(process.platform === 'darwin' ? '[data-testid="fs-fav-macintosh-hd"]' : '[data-testid="fs-fav-root"]')
  await page.waitForFunction(() => document.querySelector('[data-testid="fs-crumbs"]')?.textContent === '/')
  for (const part of path.split('/').filter(Boolean)) {
    await page.getByTestId(`fs-dir-${part}`).click()
    await page.waitForFunction((name) => document.querySelector('[data-testid="fs-crumbs"] .fs-crumb.current')?.textContent === name, part)
  }
  await page.click('[data-testid="fs-open"]')
  await page.waitForSelector('[data-testid="folder-dialog"][open]', { state: 'detached' })
}
export async function startNaturalTask(page: Page, words: string, thinking: string | null = null): Promise<string> {
  assert.ok(!words.includes('@'), 'the acceptance entry is natural language, not mention tokens')
  await page.waitForSelector('[data-testid="hero-composer"] [data-testid="director-chip"]')
  const illegal: string[] = []
  const watch = (r: Request) => { if (r.method() === 'POST' && /\/sessions\/[^/]+\/(chat|interactions)$/.test(new URL(r.url()).pathname)) illegal.push(r.url()) }
  page.on('request', watch)
  try {
    await page.fill('[data-testid="composer"]', words)
    const response = page.waitForResponse((r) => r.request().method() === 'POST' && /\/director\/messages$/.test(new URL(r.url()).pathname))
    await page.click('[data-testid="send"]')
    const answer = await response
    assert.ok(answer.ok(), `${answer.status()} ${await answer.text()}`)
    const body = answer.request().postDataJSON() as { text: string; client_request_id: string; participants?: unknown; thinking?: string | null }
    assert.equal(body.text, words)
    assert.equal(body.thinking ?? null, thinking, 'no fixture-injected effort')
    assert.ok(body.client_request_id)
    assert.equal(body.participants, undefined, 'the browser does not manufacture participants')
    await page.waitForSelector('[data-testid="thread-composer"]')
    assert.equal(await page.getByTestId('director-chip').count(), 1)
    assert.deepEqual(illegal, [], 'no silent agent fallback or client-side interaction synthesis')
    return (await page.locator('[aria-current="page"][data-testid^="session-"]').getAttribute('data-testid'))!.slice('session-'.length)
  } finally { page.off('request', watch) }
}
export async function naturalInteraction(page: Page, sid: string, status?: string): Promise<NaturalInteraction> {
  const detail = await eventually(() => pageApi<{ interactions: NaturalInteraction[] }>(page, `/api/sessions/${sid}`),
    (d) => d.interactions.length === 1 && (!status || d.interactions[0].status === status), `one natural interaction${status ? ` (${status})` : ''}`)
  return detail.interactions[0]!
}

/** Evidence checks use persisted node/run/workspace records, not rendered prose claiming there were three agents. */
export async function assertNaturalRuns(page: Page, ix: NaturalInteraction, opts: { waves: number; participants?: number; route?: string; source?: string; attachments?: number; thinking: string | null }) {
  const count = opts.participants ?? 3
  assert.equal(ix.workspace_policy, 'isolated')
  assert.equal(ix.in_place, false)
  assert.equal(ix.participants.length, count)
  assert.equal(new Set(ix.participants.map((p) => p.id)).size, count)
  for (const p of ix.participants) {
    assert.match(p.id, /^pt_[a-z0-9]+$/)
    assert.equal(p.model, opts.route ?? FABLE_FIXTURE_ROUTE)
    assert.equal(p.thinking ?? null, opts.thinking)
  }
  assert.equal(ix.nodes.length, count * opts.waves)
  assert.ok(ix.source_turn_id, 'interaction is linked to the originating director turn')
  const first = ix.nodes.filter((n) => n.wave === 1)
  assert.equal(first.length, count)
  assert.equal(new Set(first.map((n) => n.workspace_id)).size, count)
  const runIds: string[] = []
  const outputPaths = new Map<string, string>()
  for (const node of ix.nodes) {
    assert.equal(node.status, 'done')
    assert.equal(node.run_ids.length, 1, 'no duplicated or simulated node runs')
    assert.ok(node.workspace_id)
    const run = await pageApi<Run>(page, `/api/runs/${node.run_ids[0]}`)
    runIds.push(run.id)
    assert.equal(run.interaction_id, ix.id)
    assert.equal(run.interaction_node, node.id)
    assert.equal(run.model, opts.route ?? FABLE_FIXTURE_ROUTE)
    assert.equal(run.model_config_snapshot.thinking, opts.thinking)
    assert.equal(run.model_config_snapshot.thinking_sent, opts.thinking)
    const workspace = await pageApi<MountedWorkspace>(page, `/api/workspaces/${node.workspace_id}`)
    assert.equal(run.workspace_id, workspace.id)
    if (opts.source) {
      assert.equal(workspace.source_mount?.root, opts.source)
      assert.equal(workspace.source_mount?.readonly, true)
      assert.notEqual(workspace.path, opts.source)
    }
    if (node.wave === 1) {
      assert.deepEqual(node.receives, [])
      assert.deepEqual(node.depends_on, [])
      assert.equal(run.attachments.length, opts.attachments ?? 0)
      outputPaths.set(node.participant, workspace.path)
    } else {
      assert.equal(workspace.path, outputPaths.get(node.participant), 'participant keeps its own output folder')
      for (const peer of first.filter((n) => n.participant !== node.participant)) assert.ok(node.receives.includes(peer.id), 'response receives the other original answers')
    }
    // a member's run is its group's (schema v25), read on its card: the step's row in Agent Teams opens the card at that run
    await showTeams(page)
    await page.getByTestId(`ol-${run.id}`).click()
    const container = page.getByTestId(`card-run-${run.id}`)
    await container.waitFor({ timeout: 15_000 })
    assert.equal(await container.getAttribute('data-participant'), node.participant)
    await container.getByTestId('node-handover').locator('button').first().click()
    await container.getByTestId('node-output').filter({ hasText: workspace.path }).waitFor()
    assert.match(await container.getByTestId('node-route').innerText(), new RegExp((opts.route ?? FABLE_FIXTURE_ROUTE).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const thinking = `requested: ${opts.thinking ?? 'provider default / not recorded'} · sent: ${opts.thinking ?? 'none'}`
    await container.getByTestId('node-thinking').filter({ hasText: thinking }).waitFor({ timeout: 5_000 }).catch(() => undefined)
    assert.equal(await container.getByTestId('node-thinking').innerText(), thinking)
    if (node.wave > 1) assert.ok(await container.getByTestId('node-originals').locator('button').count() >= count - 1)
    if (opts.source) assert.equal(await container.getByTestId('node-adopt').count(), 0)
  }
  assert.equal(new Set(runIds).size, count * opts.waves)
  assert.equal(new Set(outputPaths.values()).size, count)
  assert.match(String(await page.getByTestId('interaction-line').getAttribute('title')), /director usage not included/)   // the usage on hover
  return runIds
}
