const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const { AGENT_BROWSER_HEADER, agentBrowserHeaders, allowReload, backendRestartDelay, attachChallenge, attachProof, backendCommand, classifyAttach, classifyBuild, dataDirOf, isLoopbackUrl, knownTokens, linkTarget, portOf, redactTokens, smokeEnv, userDataOf, windowBounds } = require('../shell')

test('the port is OASIS_CODE_PORT, 8321 by default, and must be a port', () => {
  assert.equal(portOf({}), '8321')
  assert.equal(portOf({ OASIS_CODE_PORT: '9000' }), '9000')
  assert.throws(() => portOf({ OASIS_CODE_PORT: '80; rm -rf' }), /not a port/)
  assert.throws(() => portOf({ OASIS_CODE_PORT: '70000' }), /not a port/)
})

test('only a compatible oasis-code backend is attached to', () => {
  assert.equal(classifyBuild(null, null), 'none')
  assert.equal(classifyBuild(200, { source_fingerprint: 'abc', api_version: 'code-v1' }), 'ours')
  assert.equal(classifyBuild(200, { source_fingerprint: 'abc', api_version: 'code-v0' }), 'incompatible')
  assert.equal(classifyBuild(200, { hello: 'world' }), 'other')        // oasis's 8123 or anything else
  assert.equal(classifyBuild(401, null), 'other')
})

test('the token goes only to the backend that proves it holds this data directory\'s token on this port', () => {
  const challenge = attachChallenge()
  assert.match(challenge, /^[A-Za-z0-9_-]{16,128}$/)
  assert.notEqual(attachChallenge(), challenge)
  const build = { source_fingerprint: 'abc', api_version: 'code-v1' }
  const mine = { token: 'token-of-this-data-dir', port: '8321', challenge }
  assert.equal(classifyAttach(200, { ...build, attach_proof: attachProof('token-of-this-data-dir', '8321', challenge) }, mine), 'ours')
  // another data directory's backend on this port: its token is not ours
  assert.equal(classifyAttach(200, { ...build, attach_proof: attachProof('token-of-another-data-dir', '8321', challenge) }, mine), 'foreign')
  // a listener here relaying the challenge to our real backend on another port gets that port's answer, not this one's
  assert.equal(classifyAttach(200, { ...build, attach_proof: attachProof('token-of-this-data-dir', '8400', challenge) }, mine), 'foreign')
  // an answer to an earlier challenge is not an answer to this one
  assert.equal(classifyAttach(200, { ...build, attach_proof: attachProof('token-of-this-data-dir', '8321', attachChallenge()) }, mine), 'foreign')
  // something that only looks like oasis-code (or one too old to answer), and no token to check with
  assert.equal(classifyAttach(200, build, mine), 'foreign')
  assert.equal(classifyAttach(200, { ...build, attach_proof: 42 }, mine), 'foreign')
  assert.equal(classifyAttach(200, { ...build, attach_proof: attachProof('token-of-this-data-dir', '8321', challenge) }, { ...mine, token: null }), 'foreign')
  // the rest is classifyBuild's
  assert.equal(classifyAttach(null, null, mine), 'none')
  assert.equal(classifyAttach(200, { hello: 'world' }, mine), 'other')
  assert.equal(classifyAttach(200, { ...build, api_version: 'code-v0' }, mine), 'incompatible')
})

test('the data directory, links and the reload budget', () => {
  assert.equal(dataDirOf({}, '/Users/x'), '/Users/x/.oasis-code')
  assert.equal(dataDirOf({ OASIS_CODE_DATA: '~/elsewhere' }, '/Users/x'), '/Users/x/elsewhere')
  const base = 'http://127.0.0.1:8321'
  assert.equal(linkTarget('http://127.0.0.1:8321/api/x', base), 'app')
  assert.equal(linkTarget('https://docs.python.org/3/', base), 'external')
  assert.equal(linkTarget('file:///etc/passwd', base), 'deny')
  assert.equal(linkTarget('javascript:alert(1)', base), 'deny')
  let h = []
  for (let i = 0; i < 3; i += 1) { const r = allowReload(h, 1000 + i); assert.ok(r.allowed); h = r.history }
  assert.equal(allowReload(h, 1004).allowed, false)
  assert.equal(allowReload(h, 1000 + 61_000).allowed, true)
})

test('a packaged app runs its bundled backend and UI; the source tree runs Bun and serves frontend/dist', () => {
  const packaged = backendCommand({ packaged: true, resourcesPath: '/Applications/oasis-code.app/Contents/Resources', repoRoot: '/nope', platform: 'darwin', env: {} })
  assert.equal(packaged.command, '/Applications/oasis-code.app/Contents/Resources/backend/oasis-code')
  assert.deepEqual(packaged.args, [])
  assert.equal(packaged.frontend_dist, '/Applications/oasis-code.app/Contents/Resources/ui')
  assert.equal(packaged.bundled, true)
  const win = backendCommand({ packaged: true, resourcesPath: 'C:\\app\\resources', repoRoot: 'C:\\nope', platform: 'win32', env: {} })
  assert.ok(win.command.endsWith('oasis-code.exe'))
  const dev = backendCommand({ packaged: false, resourcesPath: '/nope', repoRoot: '/repo', platform: 'linux', env: {} })
  assert.equal(dev.command, 'bun')
  assert.deepEqual(dev.args, ['run', 'src/index.ts'])
  assert.equal(dev.cwd, path.join('/repo', 'backend-ts'))
  assert.equal(dev.frontend_dist, path.join('/repo', 'frontend', 'dist'))
  assert.equal(dev.bundled, false)
  // the Python tree is gone: its old switch no longer changes what the source tree runs
  const old = backendCommand({ packaged: false, resourcesPath: '/nope', repoRoot: '/repo', platform: 'linux', env: { OASIS_CODE_BACKEND: 'python' } })
  assert.deepEqual(old, dev)
})

test('the window comes back where it was, unless that display is gone', () => {
  const displays = [{ x: 0, y: 0, width: 2560, height: 1440 }]
  assert.deepEqual(windowBounds(null, displays), { width: 1440, height: 900 })
  assert.deepEqual(windowBounds({ x: 100, y: 80, width: 1200, height: 800 }, displays), { x: 100, y: 80, width: 1200, height: 800 })
  assert.deepEqual(windowBounds({ x: 5000, y: 80, width: 1200, height: 800 }, displays), { width: 1200, height: 800 })   // off every display: size kept, position dropped
  assert.deepEqual(windowBounds({ x: 0, y: 0, width: 200, height: 100 }, displays), { width: 1440, height: 900 })         // too small to be a saved window
  assert.deepEqual(windowBounds({ x: 'a' }, displays), { width: 1440, height: 900 })
})

test('a log line carries no access token: the known ones anywhere, and whatever stands in a link\'s token place', () => {
  const known = ['Zm9vYmFyLXNlc3Npb24tdG9rZW4', 'director-secret-1234567890']
  assert.equal(redactTokens('oasis-code on http://127.0.0.1:8321/?token=Zm9vYmFyLXNlc3Npb24tdG9rZW4  (isolation: seatbelt full)', known),
    'oasis-code on http://127.0.0.1:8321/?token=…  (isolation: seatbelt full)')
  assert.equal(redactTokens('[remote] director: oasis-code director on http://127.0.0.1:8322/director-secret-1234567890/mcp', known),
    '[remote] director: oasis-code director on http://127.0.0.1:8322/…/mcp')
  assert.equal(redactTokens('a stray Zm9vYmFyLXNlc3Npb24tdG9rZW4 in an error', known), 'a stray … in an error')
  // a token the app does not know (another data directory's) is masked by where it stands
  assert.equal(redactTokens('GET /api/auth/session?token=unknownTokenValue&x=1', []), 'GET /api/auth/session?token=…&x=1')
  assert.equal(redactTokens('https://abc.trycloudflare.com/QWxhZGRpbjpvcGVuIHNlc2FtZQ/mcp', []), 'https://abc.trycloudflare.com/…/mcp')
  assert.equal(redactTokens('[shell] starting the backend: bun run src/index.ts (port 8321)', known), '[shell] starting the backend: bun run src/index.ts (port 8321)')
})

test('the known tokens are the environment\'s and the token files\' in the data directory', () => {
  const files = { '/d/session-token': 'session-token-value\n', '/d/director-token': 'director-token-value' }
  const read = (p) => { if (p in files) return files[p]; throw new Error('ENOENT') }
  assert.deepEqual(knownTokens('/d', { OASIS_CODE_SESSION_TOKEN: 'env-session-token' }, read), ['env-session-token', 'session-token-value', 'director-token-value'])
  assert.deepEqual(knownTokens('/empty', { OASIS_CODE_SESSION_TOKEN: 't' }, read), [])
})

test('test_user_data: a second app on other data never shares the person\'s Electron profile or its single-instance lock', () => {
  assert.equal(userDataOf({}, '/home/me'), null)                                              // the person's app: Electron's own
  assert.equal(userDataOf({ OASIS_CODE_DATA: '~/.oasis-code' }, '/home/me'), null)             // the default, named
  assert.equal(userDataOf({ OASIS_CODE_DATA: '/tmp/qa-data' }, '/home/me'), path.join('/tmp/qa-data', 'electron'))
  assert.equal(userDataOf({ OASIS_CODE_DATA: '/tmp/qa-data', OASIS_CODE_USER_DATA: '~/qa-profile' }, '/home/me'), path.join('/home/me', 'qa-profile'))
  assert.equal(userDataOf({ OASIS_CODE_USER_DATA: '/srv/profile' }, '/home/me'), '/srv/profile')
})

test('test_smoke_isolation: the smoke run has a data directory, a profile and a port of its own unless the person names them', () => {
  const env = smokeEnv({ PATH: '/bin' }, '/tmp/smoke-x', 50123)
  assert.deepEqual(env, { PATH: '/bin', OASIS_CODE_SMOKE: '1', OASIS_CODE_DATA: path.join('/tmp/smoke-x', 'data'), OASIS_CODE_USER_DATA: path.join('/tmp/smoke-x', 'electron'), OASIS_CODE_PORT: '50123' })
  // never the person's profile, data or port
  assert.equal(userDataOf(env, '/home/me'), path.join('/tmp/smoke-x', 'electron'))
  assert.notEqual(dataDirOf(env, '/home/me'), dataDirOf({}, '/home/me'))
  assert.notEqual(portOf(env), portOf({}))
  // what the person names is kept; a named default data directory still gets a profile of its own
  const named = smokeEnv({ OASIS_CODE_DATA: '~/.oasis-code', OASIS_CODE_PORT: '8391' }, '/tmp/smoke-y', 50124)
  assert.equal(named.OASIS_CODE_DATA, '~/.oasis-code')
  assert.equal(named.OASIS_CODE_PORT, '8391')
  assert.equal(userDataOf(named, '/home/me'), path.join('/tmp/smoke-y', 'electron'))
  assert.equal(smokeEnv({ OASIS_CODE_USER_DATA: '/srv/p' }, '/tmp/smoke-z', 1).OASIS_CODE_USER_DATA, '/srv/p')
})

test('test_agent_browser_mark: what the agent\'s browser sends to this machine is marked, what it sends to the web is not', () => {
  for (const url of ['http://127.0.0.1:8321/api/action-proposals/a_1/decide', 'http://localhost:8321/', 'http://LOCALHOST.:8321/', 'http://app.localhost:3000/',
    'http://127.1:8321/', 'http://2130706433:8321/', 'http://0.0.0.0:8321/', 'http://[::1]:8321/', 'http://[::ffff:127.0.0.1]:8321/', 'ws://127.0.0.1:8323/x']) {
    assert.equal(isLoopbackUrl(url), true, url)
    assert.equal(agentBrowserHeaders(url, { Accept: '*/*' })[AGENT_BROWSER_HEADER], '1', url)
  }
  for (const url of ['https://example.com/', 'http://127.0.0.1.example.com/', 'http://10.0.0.5:8321/', 'file:///etc/hosts', 'data:text/html,hi', 'not a url']) {
    assert.equal(isLoopbackUrl(url), false, url)
  }
  const headers = { Accept: '*/*' }
  assert.equal(agentBrowserHeaders('https://example.com/', headers), headers)                 // untouched: the web never sees the mark
})

test('a backend that ends unasked is started again a few times, each after a longer wait; past them in ten minutes it is not', () => {
  const min = 60_000
  assert.equal(backendRestartDelay([0], 0), 1_000)
  assert.equal(backendRestartDelay([0, 2 * min], 2 * min), 5_000)
  assert.equal(backendRestartDelay([0, 2 * min, 3 * min], 3 * min), 15_000)
  assert.equal(backendRestartDelay([0, 2 * min, 3 * min, 4 * min], 4 * min), null)     // a fourth in ten minutes: the person is told
  // ends long past do not count: a backend that ended once a day is always started again
  assert.equal(backendRestartDelay([0, 2 * min, 3 * min, 30 * min], 30 * min), 1_000)
  assert.equal(backendRestartDelay([], 0), null)
})

test('the gateway\'s external secret and the provider tokens it keeps are known tokens: masked in the log wherever they stand', () => {
  const files = {
    '/d/session-token': 'session-token-value', '/d/gateway/secret': 'GatewaySecretValue0123456789abcdefghijklmno',
    '/d/gateway/cloudflared-token': 'eyJhIjoiY2YtdG9rZW4tdmFsdWUifQ==', '/d/gateway/ngrok-authtoken': '2ngrokAuthTokenValue_abcdefghijkl',
  }
  const known = knownTokens('/d', {}, (p) => { if (p in files) return files[p]; throw new Error('none') })
  for (const v of Object.values(files)) assert.ok(known.includes(v), v)
  assert.equal(redactTokens('[remote] url https://mcp.example.com/GatewaySecretValue0123456789abcdefghijklmno/mcp/current ready', known), '[remote] url https://mcp.example.com/…/mcp/current ready')
  assert.equal(redactTokens('cloudflared: token eyJhIjoiY2YtdG9rZW4tdmFsdWUifQ== refused', known), 'cloudflared: token … refused')
  assert.equal(redactTokens('ngrok authtoken=2ngrokAuthTokenValue_abcdefghijkl', known), 'ngrok authtoken=…')
})
