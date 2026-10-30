// The public export on scratch repositories made in a fresh temporary folder (offline; the real repository is only
// read for its policy file). Scratch folders are left in the system temp folder, never removed by the test.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { checkPolicy, exported, landingPath, main, POLICY_PATH, runExport } from '../export-public.mjs'
import { createHash } from 'node:crypto'
import { runScan } from '../scan-secrets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, env: ENV, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const sha = (t) => createHash('sha256').update(t).digest('hex')
const scratch = (name) => mkdtempSync(join(tmpdir(), `oss-export-${name}-`))

/** A repository with the given files committed; returns its folder. */
function repoWith(files, { extra = null } = {}) {
  const dir = scratch('repo')
  git(dir, 'init', '-q', '--template=', '--initial-branch=main')
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), text)
  }
  if (extra) extra(dir)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'fixture')
  return dir
}

const policy = (over = {}) => ({
  include: ['README.md', 'LICENSE', 'src/', 'docs/PUBLIC.md', 'docs/data.json'],
  exclude: ['src/internal.ts'],
  exclude_names: ['node_modules/', 'dist/', '.env', '.env.', 'reports/'],
  keep_env_example: true,
  forbidden_extensions: ['.log', '.sqlite'],
  media: { extensions: ['.png'], allow: [{ path: 'src/assets/logo.png', sha256: sha('png'), review: 'reviewed', why: 'test' }] },
  required: ['LICENSE'],
  packages: [],
  allow: [],
  ...over,
})
const base = { 'README.md': '# x\n\n[license](LICENSE)\n', LICENSE: 'Apache License\n', 'src/a.ts': "import { b } from './b.ts'\nexport const a = b\n", 'src/b.ts': 'export const b = 1\n' }

test('the real policy is well formed and keeps docs/ and history out', () => {
  const real = JSON.parse(readFileSync(join(here, '..', 'public-export.json'), 'utf8'))
  checkPolicy(real)
  assert.equal(exported('docs/some-internal-design.md', real).ok, false)
  assert.equal(exported('docs/ssh-remote/evidence/x.log', real).ok, false)
  assert.equal(exported('backend-ts/node_modules/x/index.js', real).ok, false)
  assert.equal(exported('.env.local', real).ok, false)
  assert.equal(exported('frontend/e2e/screenshot.png', real).ok, false)
  assert.equal(exported('frontend/public/bots/icons/01-keycap.png', real).ok, true)
  assert.equal(exported('frontend/public/bots/icons/99-new-screenshot.png', real).ok, false)
  for (const m of real.media.allow) assert.ok(!m.path.endsWith('/') && /^[0-9a-f]{64}$/.test(m.sha256), m.path)
  assert.throws(() => checkPolicy({ ...real, media: { ...real.media, allow: [...real.media.allow, { path: 'frontend/public/bots/', sha256: 'a'.repeat(64), review: 'reviewed' }] } }), /one file/)
  assert.throws(() => checkPolicy({ ...real, media: { ...real.media, allow: ['frontend/src/assets/'] } }), /one file/)
  assert.equal(exported('LICENSE', real).ok, true)
  assert.throws(() => checkPolicy({ ...real, include: [...real.include, 'docs/'] }), /never included wholesale/)
  assert.throws(() => checkPolicy({ ...real, include: [...real.include, 'src/*.ts'] }), /no globs/)
})

test('only committed objects are exported: untracked files and working-tree edits never are', () => {
  const repo = repoWith(base)
  writeFileSync(join(repo, 'src', 'untracked.ts'), 'export const u = 1\n')
  writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2 // edited, not committed\n')
  const out = join(scratch('out'), 'tree')
  const { report, failing, target } = runExport({ repo, policy: policy(), rev: 'HEAD', write: true, out })
  assert.equal(failing, false)
  assert.equal(report.source_commit, git(repo, 'rev-parse', 'HEAD'))
  assert.equal(readFileSync(join(target, 'src', 'b.ts'), 'utf8'), 'export const b = 1\n')
  assert.equal(existsSync(join(target, 'src', 'untracked.ts')), false)
  assert.equal(existsSync(join(target, '.git')), false)
  assert.deepEqual(readdirSync(target).sort(), ['LICENSE', 'README.md', 'src'])
})

test('a dry run writes nothing; --commit names an exact commit', () => {
  const repo = repoWith(base)
  const first = git(repo, 'rev-parse', 'HEAD')
  writeFileSync(join(repo, 'src', 'c.ts'), 'export const c = 3\n')
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'second')
  const { report, target } = runExport({ repo, policy: policy(), rev: first })
  assert.equal(target, null)
  assert.equal(report.mode, 'dry-run')
  assert.equal(report.source_commit, first)
  assert.ok(!Object.keys(report.manifest_sha256).includes('src/c.ts'))
  assert.throws(() => runExport({ repo, policy: policy(), rev: '--all' }), /does not start with/)
})

test('docs are out unless named, media unless allowed, forbidden types always', () => {
  const repo = repoWith({ ...base, 'docs/PUBLIC.md': '# public\n', 'docs/internal.md': '# internal\n', 'src/assets/logo.png': 'png', 'src/shot.png': 'png', 'src/run.log': 'log', 'src/.env': 'X=1', 'src/.env.example': 'X=' })
  const { report } = runExport({ repo, policy: policy(), rev: 'HEAD' })
  const files = Object.keys(report.manifest_sha256)
  for (const p of ['docs/PUBLIC.md', 'src/assets/logo.png', 'src/.env.example']) assert.ok(files.includes(p), p)
  for (const p of ['docs/internal.md', 'src/shot.png', 'src/run.log', 'src/.env']) assert.ok(!files.includes(p), p)
})

test('a committed symbolic link or gitlink stops the export', () => {
  const link = repoWith(base, { extra: (d) => symlinkSync('/etc/hosts', join(d, 'src', 'escape.ts')) })
  assert.throws(() => runExport({ repo: link, policy: policy(), rev: 'HEAD' }), /symbolic link/)
  const sub = repoWith(base)
  const blob = git(sub, 'rev-parse', 'HEAD')
  git(sub, 'update-index', '--add', '--cacheinfo', `160000,${blob},src/vendored`)
  git(sub, 'commit', '-q', '-m', 'gitlink')
  assert.throws(() => runExport({ repo: sub, policy: policy(), rev: 'HEAD' }), /gitlink/)
})

test('an exported file that depends on a left-out file fails: import, quoted data path, Markdown link', () => {
  const repo = repoWith({ ...base, 'src/internal.ts': 'export const i = 1\n', 'src/uses.ts': "import { i } from './internal'\n", 'src/data.ts': "const p = join(root, 'docs', 'secret-demo.json')\n", 'docs/secret-demo.json': '{}', 'docs/PUBLIC.md': '[design](internal-design.md)\n', 'docs/internal-design.md': '# x\n' })
  const { report, failing } = runExport({ repo, policy: policy(), rev: 'HEAD' })
  assert.equal(failing, true)
  const missing = report.broken_references.map((b) => `${b.from} -> ${b.missing}`).sort()
  assert.deepEqual(missing, ['docs/PUBLIC.md -> docs/internal-design.md', 'src/data.ts -> docs/secret-demo.json', 'src/uses.ts -> src/internal.ts'])
})

test('a Markdown link to nothing, and a missing required file, fail', () => {
  const repo = repoWith({ 'README.md': '[x](docs/nowhere.md)\n', 'src/a.ts': '' })
  const { report, failing } = runExport({ repo, policy: policy(), rev: 'HEAD' })
  assert.equal(failing, true)
  assert.deepEqual(report.missing_required, ['LICENSE'])
  assert.equal(report.broken_references[0].missing, 'docs/nowhere.md')
})

test('a likely secret refuses the write: nothing is created, and the report never holds the value', () => {
  const value = ['gh', 'p_', 'Q'.repeat(36)].join('')
  const repo = repoWith({ ...base, 'src/conf.ts': `export const token = '${value}'\n` })
  const out = join(scratch('out'), 'tree')
  const { report, failing, refused } = runExport({ repo, policy: policy(), rev: 'HEAD', write: true, out })
  assert.equal(failing, true)
  assert.ok(refused)
  assert.equal(existsSync(out), false)
  assert.equal(report.secret_findings[0].rule, 'github-token')
  assert.ok(!JSON.stringify(report).includes(value))
})

test('a privacy finding fails until an exact reviewed entry covers that content', () => {
  const home = ['/Us', 'ers/', 'realperson/x'].join('')
  const repo = repoWith({ ...base, 'src/p.ts': `const p = '${home}'\n` })
  assert.equal(runExport({ repo, policy: policy(), rev: 'HEAD' }).failing, true)
  const sha = runExport({ repo, policy: policy(), rev: 'HEAD' }).report.manifest_sha256['src/p.ts']
  const ok = runExport({ repo, policy: policy({ allow: [{ path: 'src/p.ts', rule: 'home-path', sha256: sha, why: 'reviewed' }] }), rev: 'HEAD' })
  assert.equal(ok.failing, false)
  assert.equal(ok.report.allowed_findings.length, 1)
  writeFileSync(join(repo, 'src', 'p.ts'), `const p = '${home}' // changed\n`)
  git(repo, 'commit', '-qam', 'change')
  assert.equal(runExport({ repo, policy: policy({ allow: [{ path: 'src/p.ts', rule: 'home-path', sha256: sha, why: 'reviewed' }] }), rev: 'HEAD' }).failing, true)
})

test('unsafe targets are refused: existing, inside the repository; a symlinked parent is resolved', () => {
  const repo = repoWith(base)
  const existing = scratch('exists')
  assert.throws(() => runExport({ repo, policy: policy(), rev: 'HEAD', write: true, out: existing }), /already exists/)
  assert.throws(() => runExport({ repo, policy: policy(), rev: 'HEAD', write: true, out: join(repo, 'export') }), /overlaps the source/)
  const alias = join(scratch('alias'), 'link-to-repo')
  symlinkSync(repo, alias)
  assert.throws(() => runExport({ repo, policy: policy(), rev: 'HEAD', write: true, out: join(alias, 'export') }), /overlaps the source/)
})

test('modes are kept; --git-init makes a local repository with no remote, and commits only with an author', () => {
  const repo = repoWith({ ...base, 'src/run.sh': '#!/bin/sh\n' }, { extra: (d) => spawnSync('chmod', ['755', join(d, 'src', 'run.sh')]) })
  const staged = runExport({ repo, policy: policy(), rev: 'HEAD', write: true, out: join(scratch('out'), 'tree'), gitInitTarget: true })
  assert.equal(statSync(join(staged.target, 'src', 'run.sh')).mode & 0o777, 0o755)
  assert.deepEqual(staged.report.git, { initialized: true, committed: null })
  assert.equal(git(staged.target, 'remote'), '')
  // no template: no sample hooks were copied in
  assert.ok(!existsSync(join(staged.target, '.git', 'hooks')) || readdirSync(join(staged.target, '.git', 'hooks')).length === 0)
  const committed = runExport({ repo, policy: policy(), rev: 'HEAD', write: true, out: join(scratch('out'), 'tree'), gitInitTarget: true, gitAuthor: 'Public Tree <public@example.invalid>' })
  assert.match(committed.report.git.committed, /^[0-9a-f]{40}$/)
  assert.equal(git(committed.target, 'log', '--format=%an <%ae>'), 'Public Tree <public@example.invalid>')
  assert.equal(git(committed.target, 'rev-list', '--count', 'HEAD'), '1')
})

test('the scan keeps snapshot and history apart: a secret removed later is history-only', () => {
  const value = ['AK', 'IA', 'R'.repeat(16)].join('')
  const repo = repoWith({ ...base, 'src/old.ts': `const k = '${value}'\n` })
  writeFileSync(join(repo, 'src', 'old.ts'), 'const k = process.env.K\n')
  git(repo, 'commit', '-qam', 'remove it')
  const snap = runScan({ repo, mode: 'snapshot', rev: 'HEAD' })
  assert.equal(snap.counts.secret, 0)
  const hist = runScan({ repo, mode: 'history', rev: 'HEAD' })
  assert.equal(hist.counts.secret, 1)
  const f = hist.findings.find((x) => x.kind === 'secret')
  assert.equal(f.in_snapshot, false)
  assert.equal(f.first_commit, git(repo, 'rev-list', '--max-parents=0', 'HEAD'))
  assert.ok(!JSON.stringify(hist).includes(value))
  assert.equal(hist.identities.length, 1)
})

test('media: only exactly reviewed content; a changed reviewed file and an unlisted binary fail, a stale entry is listed', () => {
  const repo = repoWith({ ...base, 'src/assets/logo.png': 'png', 'src/assets/new-shot.png': 'unreviewed', 'src/blob.bin': Buffer.from([0, 1, 2, 3]) })
  const r1 = runExport({ repo, policy: policy(), rev: 'HEAD' })
  assert.ok(!Object.keys(r1.report.manifest_sha256).includes('src/assets/new-shot.png'))
  assert.deepEqual(r1.report.media_problems.map((m) => m.path), ['src/blob.bin'])
  assert.equal(r1.failing, true)
  writeFileSync(join(repo, 'src', 'assets', 'logo.png'), 'png, edited after review')
  spawnSync('git', ['rm', '-q', 'src/blob.bin'], { cwd: repo, env: ENV })
  git(repo, 'commit', '-qam', 'edit')
  const r2 = runExport({ repo, policy: policy(), rev: 'HEAD' })
  assert.deepEqual(r2.report.media_problems.map((m) => m.path), ['src/assets/logo.png'])
  assert.equal(r2.failing, true)
  const pending = policy({ media: { extensions: ['.png'], allow: [{ path: 'src/assets/logo.png', sha256: sha('png, edited after review'), review: 'pending-owner-review', why: 'art' }, { path: 'src/assets/gone.png', sha256: sha('x'), review: 'reviewed', why: 'stale' }] } })
  const r3 = runExport({ repo, policy: pending, rev: 'HEAD' })
  assert.deepEqual(r3.report.media_pending_owner_review.map((m) => m.path), ['src/assets/logo.png'])
  assert.deepEqual(r3.report.media_problems, [])
  assert.deepEqual(r3.report.media_entries_not_exported, ['src/assets/gone.png'])
  assert.equal(r3.failing, false)
})

test('the CLI reads the policy from the exported commit: an uncommitted policy edit cannot widen the export', () => {
  const committed = JSON.stringify(policy())
  const repo = repoWith({ ...base, [POLICY_PATH]: committed, 'secret-notes/plan.md': '# private\n' })
  const widened = JSON.stringify(policy({ include: [...policy().include, 'secret-notes/'] }))
  writeFileSync(join(repo, POLICY_PATH), widened)
  const report = join(scratch('reports'), 'r.json')
  const lines = []
  const code = main(['--commit', 'HEAD', '--repo', repo, '--report', report], { log: (l) => lines.push(l), error: (l) => lines.push(l) })
  const r = JSON.parse(readFileSync(report, 'utf8'))
  assert.ok(!Object.keys(r.manifest_sha256).some((p) => p.startsWith('secret-notes/')), 'the dirty policy was used')
  assert.equal(r.policy.sha256, sha(committed))
  assert.equal(r.policy.path, POLICY_PATH)
  assert.ok(code === 0 || code === 1, lines.join('\n'))
  const bare = repoWith(base)
  assert.equal(main(['--commit', 'HEAD', '--repo', bare], { log: () => {}, error: () => {} }), 2)
})

test('a report that would land inside --out through a symbolic-link alias is refused, and nothing is overwritten', () => {
  const repo = repoWith({ ...base, [POLICY_PATH]: JSON.stringify(policy()) })
  const parent = scratch('out')
  const out = join(parent, 'tree')
  const alias = join(scratch('alias'), 'to-parent')
  symlinkSync(parent, alias)
  const viaAlias = join(alias, 'tree', 'export-report.json')
  assert.equal(landingPath(viaAlias), join(landingPath(parent), 'tree', 'export-report.json'))
  const errors = []
  assert.equal(main(['--commit', 'HEAD', '--repo', repo, '--write', '--out', out, '--report', viaAlias], { log: () => {}, error: (l) => errors.push(l) }), 2)
  assert.match(errors.join('\n'), /must not land inside --out/)
  assert.equal(existsSync(out), false)
  const existing = join(scratch('reports'), 'r.json')
  writeFileSync(existing, 'keep')
  assert.equal(main(['--commit', 'HEAD', '--repo', repo, '--report', existing], { log: () => {}, error: () => {} }), 2)
  assert.equal(readFileSync(existing, 'utf8'), 'keep')
  const fine = join(scratch('reports'), 'ok.json')
  assert.equal(main(['--commit', 'HEAD', '--repo', repo, '--write', '--out', join(scratch('out2'), 'tree'), '--report', fine], { log: () => {}, error: () => {} }), 0)
  assert.ok(existsSync(fine))
})

test('ambient GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE cannot redirect the export, the scan or --git-init', () => {
  const repo = repoWith(base)
  const other = repoWith({ 'other.txt': 'other\n' })
  const otherHead = git(other, 'rev-parse', 'HEAD')
  const otherIndex = readFileSync(join(other, '.git', 'index'))
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 }
  Object.assign(process.env, { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, '.git', 'index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: join(other, 'hooks') })
  let result, scan
  try {
    result = runExport({ repo, policy: policy(), rev: 'HEAD', write: true, out: join(scratch('out'), 'tree'), gitInitTarget: true, gitAuthor: 'Public Tree <public@example.invalid>' })
    scan = runScan({ repo, mode: 'snapshot', rev: 'HEAD' })
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
  assert.equal(result.report.source_commit, git(repo, 'rev-parse', 'HEAD'))
  assert.ok(Object.keys(result.report.manifest_sha256).includes('src/a.ts'))
  assert.equal(scan.source_commit, git(repo, 'rev-parse', 'HEAD'))
  assert.equal(git(other, 'rev-parse', 'HEAD'), otherHead)
  assert.ok(readFileSync(join(other, '.git', 'index')).equals(otherIndex))
  assert.equal(git(other, 'status', '--porcelain'), '')
  assert.equal(git(result.target, 'ls-files').split('\n').sort().join(','), 'LICENSE,README.md,src/a.ts,src/b.ts')
  assert.equal(git(result.target, 'rev-list', '--count', 'HEAD'), '1')
})
