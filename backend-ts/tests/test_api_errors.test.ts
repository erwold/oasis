/** The API's last resort: an exception no route caught answers 500 with a reference to find it in the log and
 *  nothing of the exception itself — a library's error may quote a credential — while the log keeps the detail,
 *  masked, under the same reference, and the server goes on answering. */

import { expect, test } from 'bun:test'
import { Client, makeApp } from './api_harness.ts'

test('an unhandled exception answers a generic 500 with a log reference; its text reaches the log masked and the response never', async () => {
  const app = await makeApp()
  const secret = 'SYNTHETIC_SECRET_QA_88731'
  const logged: string[] = []
  const priorError = console.error
  try {
    app.state.workspaces.importProject = async () => { throw new Error(`upstream request failed with token=${secret} (key sk-ant-api03-${secret})`) }
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    const client = new Client(app)
    const response = await client.post('/api/projects', { source_path: '/synthetic-fixture' })
    expect(response.status).toBe(500)
    const body = await response.json() as { detail: string; reference: string }
    expect(body.reference).toMatch(/^err_[0-9a-f]{8}$/)
    expect(body.detail).toBe(`internal error (reference ${body.reference}); the server log has the details`)
    expect(JSON.stringify(body)).not.toContain(secret)
    expect(JSON.stringify(body)).not.toContain('upstream request failed')
    const line = logged.join('\n')
    expect(line).toContain(`internal error ${body.reference} on POST /api/projects: Error: upstream request failed with token=… (key sk-…)`)
    expect(line).not.toContain(secret)
    expect((await client.get('/api/projects')).status).toBe(200)
  } finally {
    console.error = priorError
    await app.close()
  }
})
