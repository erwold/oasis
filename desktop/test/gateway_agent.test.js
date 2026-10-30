// The gateway's launchd agent, pure parts: one label per data directory, absolute programs only (Bun found without a
// shell PATH; a relative bundled path refused), an environment of named values, an XML-escaped plist, launchd's
// `print` read, and ports checked.

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { agentEnv, findBun, gatewayProgram, labelFor, parsePrint, plistXml, portsOf, AGENT_PATH } = require('../gateway_agent')

test('one label per data directory: the person\'s and a test\'s never collide; the same folder spelled two ways is one label', () => {
  const a = labelFor('/Users/p/.oasis-code')
  assert.match(a, /^dev\.oasis-code\.gateway\.[0-9a-f]{12}$/)
  assert.notEqual(a, labelFor('/tmp/smcp/data'))
  assert.equal(labelFor('/Users/p/.oasis-code'), labelFor('/Users/p/./.oasis-code/'))
})

test('the program is absolute: the bundled backend as it is, the source tree through Bun found in fixed places or PATH (never a bare name)', () => {
  assert.deepEqual(gatewayProgram({ bundled: true, command: '/Applications/oasis-code.app/Contents/Resources/backend/oasis-code', cwd: '/Applications/oasis-code.app/Contents/Resources/backend' }, { bun: null }),
    { program: '/Applications/oasis-code.app/Contents/Resources/backend/oasis-code', args: ['/Applications/oasis-code.app/Contents/Resources/backend/oasis-code', 'gateway', 'run'], cwd: '/Applications/oasis-code.app/Contents/Resources/backend' })
  assert.throws(() => gatewayProgram({ bundled: true, command: 'oasis-code', cwd: '.' }, { bun: null }), /not absolute/)
  assert.deepEqual(gatewayProgram({ bundled: false, command: 'bun', cwd: '/repo/backend-ts' }, { bun: '/Users/p/.bun/bin/bun' }).args, ['/Users/p/.bun/bin/bun', 'run', '/repo/backend-ts/src/index.ts', 'gateway', 'run'])
  assert.throws(() => gatewayProgram({ bundled: false, command: 'bun', cwd: '/repo/backend-ts' }, { bun: null }), /Bun was not found/)
  assert.equal(findBun({ env: {}, home: '/Users/p', exists: (p) => p === '/Users/p/.bun/bin/bun' }), '/Users/p/.bun/bin/bun')
  assert.equal(findBun({ env: { PATH: 'relative/bin:/opt/x/bin' }, home: '/h', exists: (p) => p === '/opt/x/bin/bun' || p === 'relative/bin/bun' }), '/opt/x/bin/bun')
  assert.equal(findBun({ env: { PATH: 'relative/bin' }, home: '/h', exists: (p) => p === 'relative/bin/bun' }), null)
})

test('the environment is named values only, and the plist escapes what it holds', () => {
  const env = agentEnv({ dataDir: '/d', userData: '/u', ports: { harness: '8391', director: '8392', bridge: '8393', gateway: '8394' }, home: '/Users/p', build: 'abc' })
  assert.deepEqual(env, { OASIS_CODE_DATA: '/d', OASIS_CODE_USER_DATA: '/u', OASIS_CODE_PORT: '8391', OASIS_CODE_DIRECTOR_PORT: '8392', OASIS_CODE_BRIDGE_PORT: '8393', OASIS_CODE_GATEWAY_PORT: '8394', HOME: '/Users/p', PATH: AGENT_PATH, OASIS_CODE_GATEWAY_BUILD: 'abc' })
  const text = plistXml({ label: 'dev.oasis-code.gateway.x', program: '/a&b/<bun>', args: ['/a&b/<bun>', 'run'], cwd: '/c"d', env: { K: '<v&>' }, logPath: '/l' })
  assert.ok(text.includes('<string>/a&amp;b/&lt;bun&gt;</string>'))
  assert.ok(text.includes('<string>/c&quot;d</string>'))
  assert.ok(text.includes('<string>&lt;v&amp;&gt;</string>'))
  assert.ok(!text.includes('<bun>'))
})

test('launchd\'s print is read for state, pid, program and arguments; ports are checked', () => {
  const p = parsePrint('gui/501/x = {\n\tactive count = 1\n\tpath = /Users/p/Library/LaunchAgents/x.plist\n\tstate = running\n\n\tprogram = /Users/p/.bun/bin/bun\n\targuments = {\n\t\t/Users/p/.bun/bin/bun\n\t\trun\n\t\t/repo/backend-ts/src/index.ts\n\t\tgateway\n\t\trun\n\t}\n\n\tpid = 4321\n}')
  assert.deepEqual(p, { state: 'running', pid: 4321, program: '/Users/p/.bun/bin/bun', args: ['/Users/p/.bun/bin/bun', 'run', '/repo/backend-ts/src/index.ts', 'gateway', 'run'], path: '/Users/p/Library/LaunchAgents/x.plist' })
  assert.deepEqual(parsePrint('gui/501/x = {\n\tstate = not running\n}'), { state: 'not running', pid: null, program: null, args: [], path: null })
  assert.deepEqual(portsOf({}, '8321'), { harness: '8321', director: '8322', bridge: '8323', gateway: '8324' })
  assert.throws(() => portsOf({ OASIS_CODE_GATEWAY_PORT: '99999' }, '8321'), /not a port/)
  assert.ok(path.isAbsolute(AGENT_PATH.split(':')[0]))
})
