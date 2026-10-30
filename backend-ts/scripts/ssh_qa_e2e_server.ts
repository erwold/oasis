/** Controlled real-system-sshd e2e backend. No pod or user SSH config/key. Port is 8399 only.
 * Scripted model decisions derive from this conversation's explicit marker/tool returns, never global steps(). */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Settings } from '../src/config.ts'
import { createApp } from '../src/main.ts'
import { isRequest, modelResponse, textPart, toolCallPart, userTexts, type ModelMessage } from '../src/llm/messages.ts'
import { scriptedModel, testConfig } from '../tests/harness.ts'
import { installNetworkGuard } from '../tests/network_guard.ts'
import { LoopbackSshd } from '../tests/remote/loopback_sshd.ts'

const port = Number(process.env.OASIS_CODE_E2E_PORT ?? 8399)
if (port !== 8399) throw new Error('SSH e2e must run serially on 8399')
const root = mkdtempSync(join(process.env.OASIS_CODE_E2E_TMP ?? '/tmp', 'qa-ssh-app-'))
const fixture = await LoopbackSshd.start({ parent: root })
mkdirSync(join(fixture.workspace, 'visible-directory'))
writeFileSync(join(fixture.workspace, 'proof.txt'), 'REMOTE_FIXTURE_INITIAL\n')
process.env.OASIS_TEST_KEY_A = 'qa-fake-not-a-provider-credential'
process.env.OASIS_TEST_KEY_B = 'qa-fake-not-a-provider-credential'
function lastReturn(messages: ModelMessage[], tool: string): unknown {
  const parts = messages.flatMap((m) => isRequest(m) ? m.parts.filter((p) => p.part_kind === 'tool-return' && (p as { tool_name: string }).tool_name === tool) : [])
  return (parts.at(-1) as { content?: unknown } | undefined)?.content
}
function markerScript(messages: ModelMessage[]) {
  const marker = userTexts(messages).filter((text) => text.includes('QA_REMOTE_')).at(-1) ?? ''
  const returned = new Set(messages.flatMap((m) => isRequest(m) ? m.parts.filter((p) => p.part_kind === 'tool-return').map((p) => (p as { tool_name: string }).tool_name) : []))
  // the person asks in a conversation of this computer; the agent connects the fixture's host on their Connect, then
  // opens a session in the fixture's folder there and hands it the command
  if (marker.includes('QA_REMOTE_CONNECT')) {
    if (!returned.has('ssh_connect')) return modelResponse([toolCallPart('ssh_connect', { destination: fixture.alias, identity_file: fixture.clientKey, name: 'QA real SSH' }, '')])
    const content = lastReturn(messages, 'ssh_connect')
    const host = (typeof content === 'string' ? JSON.parse(content) : content)?.host as { target_id?: string } | undefined
    if (host?.target_id && !returned.has('open_ssh_session')) return modelResponse([toolCallPart('open_ssh_session', { target_id: host.target_id, path: fixture.workspace, message: 'QA_REMOTE_COMMAND' }, '')])
  }
  if (marker.includes('QA_REMOTE_COMMAND') && !returned.has('bash')) return modelResponse([toolCallPart('bash', { command: "printf 'QA_REMOTE_COMMAND_DONE\\n'; pwd", wait_s: 5 }, '')])
  if (marker.includes('QA_REMOTE_READ') && !returned.has('read_file')) return modelResponse([toolCallPart('read_file', { path: 'proof.txt' }, '')])
  return modelResponse([textPart('QA_REMOTE_SCRIPT_COMPLETE')])
}
installNetworkGuard()
const app = await createApp(new Settings({ data_dir: join(root, 'data'), host: '127.0.0.1', port, session_token: 'ssh-qa-fixture-token' }), testConfig(), {
  probe: true,
  remote_transport: { config_file: fixture.configFile, known_hosts_file: fixture.knownHostsFile, rpc_timeout_ms: 10_000 },
  model_overrides: { 'scripted:a': scriptedModel(markerScript), 'scripted:b': scriptedModel(markerScript) },
})
await app.start()
const server = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch, idleTimeout: 255 })
console.log(JSON.stringify({ port, root, remote_path: fixture.workspace, destination: fixture.alias, ssh_port: fixture.port, identity_file: fixture.clientKey, token: 'ssh-qa-fixture-token', isolation: app.state.isolation.enforcement }))
let closing = false
async function close() {
  if (closing) return
  closing = true
  server.stop(true)
  await app.close()
  await fixture.close({ keepEvidence: true })
  // Retain failed e2e data and PID ledger, never the generated private keys.
  process.exit(0)
}
process.on('SIGTERM', () => { void close().catch(() => { process.exitCode = 1 }) })
process.on('SIGINT', () => { void close().catch(() => { process.exitCode = 1 }) })
