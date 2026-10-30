/** The private HOME every git invocation runs under is the app's own temporary folder: a clean shutdown removes it,
 *  and a workspace service handed a host leaves that host to its caller. */

import { expect, test } from 'bun:test'
import { existsSync, mkdirSync } from 'node:fs'
import { connect } from '../src/db/database.ts'
import { GitHost } from '../src/workspace/git.ts'
import { WorkspaceService } from '../src/workspace/service.ts'
import { makeApp } from './api_harness.ts'
import { testSettings } from './harness.ts'

test('the app removes its git HOME when it closes', async () => {
  const app = await makeApp()
  const home = app.state.workspaces.git.env().HOME!
  expect(existsSync(home)).toBe(true)
  await app.close()
  expect(existsSync(home)).toBe(false)
})

test('a host passed to the workspace service is the caller\'s to close', () => {
  const settings = testSettings()
  mkdirSync(settings.data_dir, { recursive: true })
  const conn = connect(settings.db_path)
  const git = new GitHost()
  const home = git.env().HOME!
  try {
    new WorkspaceService(settings, conn, git).close()
    expect(existsSync(home)).toBe(true)
    git.close()
    expect(existsSync(home)).toBe(false)
  } finally {
    git.close()
    conn.close()
  }
})
