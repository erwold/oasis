/** The browser e2e's image route (scripted:img) and its fake image service, run here on the real tool: a message with
 *  no image makes one (IMG_DONE), a message with an image attached edits it (IMG_EDITED), whatever ran before — the
 *  script reads the conversation, not a counter. Nothing leaves the machine; no credential is read. */

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { resetImageHooks } from '../src/agent/tools/images.ts'
import type { ImageAttachment } from '@oasis-code/contract'
import { assetAttachment } from '../src/llm/attachments.ts'
import { ModelConfig } from '../src/config.ts'
import * as repo from '../src/db/repo.ts'
import { fakeImageService, imageRequests, imageScript } from '../scripts/e2e_server.ts'
import { appState, buggyRepo, closeState, openSession, scriptedModel, setModel, testConfig, waitDone, type AppState } from './harness.ts'

let state: AppState | null = null
afterEach(async () => { resetImageHooks(); if (state) await closeState(state); state = null })

const answer = (st: AppState, runId: string) => repo.listEvents(st.conn, runId).filter((e) => e.event === 'text_block').map((e) => String(e.data.text)).join('')

test('scripted:img makes an image for a plain message and edits the attached one, each from the conversation itself', async () => {
  const config = testConfig()
  config.models.push(new ModelConfig({ id: 'scripted:img', label: 'Scripted Image', provider: 'anthropic', model: 'scripted-img', api_key_env: 'OASIS_TEST_KEY_A', capabilities: { images: true } }))
  state = await appState({ config })
  fakeImageService()
  imageRequests.length = 0
  setModel(state, 'scripted:img', scriptedModel(imageScript(), 'scripted-img'))
  const { session } = await openSession(state, buggyRepo(), 'scripted:img')
  const first = await waitDone(state, (await state.runs.start(session, 'draw a red square')).id)
  const made = /^IMG_DONE (\S+)$/.exec(answer(state, first.id))
  expect(made).not.toBeNull()
  const asset = repo.getAsset(state.conn, made![1]!)!
  expect(asset.meta).toMatchObject({ role: 'attachment', session_id: session.id, width: 64, height: 64 })
  // the generated image dragged back into the composer: the same asset, attached to the next message
  const attachment = assetAttachment(asset) as ImageAttachment
  const second = await waitDone(state, (await state.runs.start(session, 'make it blue', { attachments: [attachment] })).id)
  const edited = /^IMG_EDITED (\S+)$/.exec(answer(state, second.id))
  expect(edited).not.toBeNull()
  expect(edited![1]).not.toBe(asset.id)
  expect(imageRequests.map((r) => r.kind)).toEqual(['generate', 'edit'])
  expect(imageRequests.map((r) => r.prompt)).toEqual(['draw a red square', 'make it blue'])
  expect(imageRequests[1]!.reference_sha256).toEqual([createHash('sha256').update(state.store.read(asset.storage_path)).digest('hex')])
  const result = repo.listEvents(state.conn, second.id).find((e) => e.event === 'tool_result' && e.data.tool === 'generate_image')!.data
  expect(result).toMatchObject({ generated: true, references: [asset.id], shown: [{ asset_id: edited![1], width: 64, height: 64, label: 'generated-image.png' }] })
  // a third plain message makes a new image again (no counter: the conversation decides)
  const third = await waitDone(state, (await state.runs.start(session, 'another one')).id)
  expect(answer(state, third.id)).toStartWith('IMG_DONE ')
})
