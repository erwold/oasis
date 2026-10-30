/** `bun run build`: a compiled backend that macOS would refuse to run (the ad-hoc signature failed) is a failed
 *  build, never exit 0; elsewhere there is no signing to fail. The script is run as package.json has it, through
 *  `bun run`, with the compile step stood in for and `uname` / `codesign` played by stubs on the PATH. */

import { expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { removeDir, tempDir } from './helpers.ts'

/** the compiled binary's entries: the backend, and the two workers it starts from its own file (the fork watch, the live
 *  share's projector) — a worker left out of the compile is missing from the binary */
const ENTRIES = ['src/index.ts', 'src/execution/fork_watch_worker.ts', 'src/share/live/projector_worker.ts']
const COMPILE = `bun build --compile --target=bun ${ENTRIES.join(' ')} --outfile dist/oasis-code`

function buildScript(): string {
  const scripts = (JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  return scripts.build
}

function runBuild(system: string, codesignExit: number): { code: number; signed: boolean; stderr: string } {
  const dir = tempDir('oasis-build-')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755) }
  stub('uname', `echo ${system}`)
  stub('codesign', `touch "${join(dir, 'signed')}"; echo "codesign stub exits ${codesignExit}" >&2; exit ${codesignExit}`)
  // the compile step is the real script's, stood in for by making its output: what follows it is under test (never a
  // real compile: the stand-in must have taken its place)
  const script = buildScript().replace(COMPILE, 'mkdir -p dist && touch dist/oasis-code')
  if (script === buildScript()) throw new Error('the build script no longer starts with the expected compile step')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'build-probe', private: true, scripts: { build: script } }))
  const result = Bun.spawnSync(['bun', 'run', 'build'], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
  const signed = existsSync(join(dir, 'signed'))
  removeDir(dir)
  return { code: result.exitCode, signed, stderr: result.stderr.toString() }
}

test('the build script compiles its three entries and then signs on macOS', () => {
  const script = buildScript()
  expect(script.startsWith(`${COMPILE} && `)).toBe(true)
  // the entries, read back from the script itself: exactly these three, each a file of this package
  const entries = /^bun build --compile --target=bun (.+?) --outfile dist\/oasis-code && /.exec(script)?.[1]?.split(' ')
  expect(entries).toEqual(ENTRIES)
  for (const entry of ENTRIES) expect(existsSync(join(import.meta.dir, '..', entry)), entry).toBe(true)
  // then the ad-hoc signature, on macOS only, of the compiled file
  expect(script.slice(COMPILE.length)).toBe(' && (test "$(uname -s)" != Darwin || codesign --force --sign - dist/oasis-code)')
})

test('a failed ad-hoc signature on macOS fails the build', () => {
  const failed = runBuild('Darwin', 7)
  expect(failed.signed).toBe(true)
  expect(failed.code).not.toBe(0)
  const ok = runBuild('Darwin', 0)
  expect(ok.signed).toBe(true)
  expect(ok.code).toBe(0)
})

test('elsewhere the build is not signed and does not fail for it', () => {
  const linux = runBuild('Linux', 7)
  expect(linux.signed).toBe(false)
  expect(linux.code).toBe(0)
})
