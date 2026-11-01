#!/usr/bin/env node
// The whole THIRD_PARTY_NOTICES.md chain from a checkout whose four packages are installed: the real frontend bundle
// (Vite, recording the modules it holds), the real backend bundle (Bun, with a metafile), then the inventory —
// written (--write) or compared with the committed file (--check, for CI). Every build output goes into --work-dir,
// a folder this script creates and never empties or removes; it refuses one that already exists.
//
//   node scripts/oss/notices.mjs --work-dir /new/folder (--check | --write)
//
// The installed packages are read from this checkout (frontend/, backend-ts/, contract/, desktop/ node_modules);
// an installed copy that differs from its lock is reported as such in the file, never taken for the locked version.
// Exit 0 ok / up to date, 1 failure or out of date, 2 bad arguments.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCli } from './lib/args.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function steps(work) {
  const feInputs = join(work, 'frontend-inputs.json')
  const beMeta = join(work, 'backend-meta.json')
  return {
    feInputs, beMeta,
    vite: { cwd: join(REPO, 'frontend'), cmd: process.execPath, env: { OASIS_CODE_INPUTS_OUT: feInputs },
      args: [join(REPO, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--configLoader', 'native', '--config', '../scripts/oss/vite-inputs.config.mjs', '--outDir', join(work, 'frontend-dist'), '--emptyOutDir', 'false', '--logLevel', 'warn'] },
    bun: { cwd: join(REPO, 'backend-ts'), cmd: 'bun', env: {},
      args: ['build', '--target=bun', 'src/index.ts', 'src/execution/fork_watch_worker.ts', 'src/share/live/projector_worker.ts', 'src/agent/context_report_worker.ts', '--outdir', join(work, 'backend-bundle'), `--metafile=${beMeta}`] },
  }
}

function run({ cwd, cmd, args, env }) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(' ')} … failed (${r.error?.message ?? `exit ${r.status}`})`)
}

function main() {
  let cli
  try {
    cli = parseCli(process.argv.slice(2), { flags: ['--check', '--write'], values: ['--work-dir'] })
    if (!cli.values['--work-dir']) throw new Error('--work-dir is required (a new folder for the build outputs)')
    if (cli.flags.has('--check') === cli.flags.has('--write')) throw new Error('give exactly one of --check and --write')
  } catch (e) { console.error(`notices: ${e.message}`); process.exit(2) }
  const work = resolve(cli.values['--work-dir'])
  if (existsSync(work)) { console.error(`notices: ${work} already exists; name a new folder (nothing is overwritten or removed)`); process.exit(2) }
  try {
    for (const pkg of ['frontend', 'backend-ts', 'contract', 'desktop']) if (!existsSync(join(REPO, pkg, 'node_modules'))) throw new Error(`${pkg}/node_modules is missing: install the four packages first (bun install in backend-ts, npm ci in frontend and desktop)`)
    mkdirSync(work, { recursive: true })
    const s = steps(work)
    run(s.vite)
    run(s.bun)
    const mode = cli.flags.has('--check') ? ['--check', join(REPO, 'THIRD_PARTY_NOTICES.md')] : ['--out', join(REPO, 'THIRD_PARTY_NOTICES.md')]
    run({ cwd: REPO, cmd: process.execPath, env: {}, args: [join(REPO, 'scripts', 'oss', 'third-party-notices.mjs'), '--modules-root', REPO, '--frontend-inputs', s.feInputs, '--backend-metafile', s.beMeta, ...mode] })
    console.log(`notices: build outputs kept in ${work}`)
  } catch (e) {
    console.error(`notices: ${e.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
