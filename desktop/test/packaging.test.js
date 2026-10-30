const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { asarFiles, ENTRY_POINTS, localRequires, missingFromPackage, requireClosure } = require('../packaging')

const desktop = path.resolve(__dirname, '..')

test('local requires are read with and without .js, nothing else', () => {
  assert.deepEqual(localRequires("const a = require('./shell')\nconst { b } = require(\"./bridge.js\")\nrequire('electron')\nrequire('node:fs')\nrequire('../devbundle')"), ['shell.js', 'bridge.js'])
})

test('the closure of the entry points follows requires transitively and names every file it needs', () => {
  const closure = requireClosure(desktop, ENTRY_POINTS)
  for (const name of ['main.js', 'preload.js', 'shell.js', 'bridge.js', 'chatgpt_dom.js', 'chatgpt_tap.js', 'chatgpt_stream.js']) assert.ok(closure.includes(name), name)
  assert.ok(!closure.includes('devbundle.js'), 'devbundle is the source tree\'s, not the app\'s')
})

test('package.json build.files carries the whole closure (a require added without its file fails here, not at launch)', () => {
  const files = require('../package.json').build.files
  assert.deepEqual(missingFromPackage(requireClosure(desktop, ENTRY_POINTS), files), [])
  assert.ok(files.includes('package.json'))
})

test('an asar header is read without a dependency and a missing module is named', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-asar-'))
  try {
    // an archive as electron-builder writes one: the pickle (four uint32) + the JSON header + the file bytes
    const header = { files: { 'main.js': { size: 3, offset: '0' }, 'package.json': { size: 2, offset: '3' }, node_modules: { files: { 'x.js': { size: 1, offset: '5' } } } } }
    const json = Buffer.from(JSON.stringify(header))
    const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)])
    const pickle = Buffer.alloc(16)
    pickle.writeUInt32LE(4, 0)
    pickle.writeUInt32LE(padded.length + 8, 4)
    pickle.writeUInt32LE(padded.length + 4, 8)
    pickle.writeUInt32LE(json.length, 12)
    const archive = path.join(tmp, 'app.asar')
    fs.writeFileSync(archive, Buffer.concat([pickle, padded, Buffer.from('abcdef')]))
    assert.deepEqual(asarFiles(archive), ['/main.js', '/node_modules/x.js', '/package.json'])
    assert.deepEqual(missingFromPackage(['main.js', 'bridge.js'], asarFiles(archive)), ['bridge.js'])
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
