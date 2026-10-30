#!/usr/bin/env node
// Builds a history-less public *candidate* source tree from the committed files of one named commit (read from git
// objects — never the working tree, never untracked files), through the policy committed in that same commit at
// scripts/oss/public-export.json (an uncommitted edit of the policy has no effect). Dry run by default: it lists what
// would be exported and what the checks find, and writes nothing.
//
//   node scripts/oss/export-public.mjs --commit REV [--repo DIR] [--report FILE] [--markers FILE]        (dry run)
//   node scripts/oss/export-public.mjs --commit REV --write --out NEW_DIR [--git-init [--git-author "Name <email>"]]
//                                      [--repo DIR] [--report FILE] [--markers FILE]
//
// --commit REV   required: the commit to export; its full id and the sha256 of the policy blob read from it are
//                recorded in the report
// --repo DIR     the repository to read (default: the one this script is in)
// --write        write the files into --out, a folder that must not exist yet (created with one mkdir, outside the
//                source repository); nothing is ever overwritten, emptied or removed
// --git-init     after writing, make the folder a new local repository (no template, no hooks, no remote) and stage the
//                files; with --git-author it also makes one root commit as that identity. Nothing is pushed and no
//                remote is created: where and how the tree is published is the owner's decision.
// --report FILE  write the JSON report there (a new file; refused when its real location — symbolic links resolved —
//                is inside --out). The tree itself carries nothing but the exported files.
// --markers FILE owner-supplied private literals (see scan-secrets.mjs); a match is a privacy finding
//
// The export stops (exit 1, nothing written) on: a likely secret or a privacy finding not covered by an exact reviewed
// entry (path + rule + sha256); a binary file or media file that is not an exactly reviewed entry (path + sha256); an
// exported file that depends on a tracked file the policy leaves out (a module import, a quoted path, a data file, a
// Markdown link); a broken relative Markdown link; a required file missing. It refuses (exit 2) a symbolic link,
// gitlink, unsafe path or case collision anywhere in the commit's tree, a commit without a committed policy, an unknown
// option, and an unsafe or existing target. Every git call runs with an isolated environment. Nothing touches the
// network.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseCli } from './lib/args.mjs'
import { checkAllowList, looksText, parseMarkers, scanText } from './lib/scan.mjs'
import { caseCollisions, isolatedGitEnv, listTree, readBlobs, readCommittedFile, resolveCommit, SAFE_GIT_OPTIONS, treeProblems } from './lib/git.mjs'
import { codeSpecifiers, isCode, literalCandidates, markdownLinks, pathLiterals, specifierCandidates } from './lib/refs.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const POLICY_PATH = 'scripts/oss/public-export.json'
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const ext = (p) => (basename(p).includes('.') ? basename(p).slice(basename(p).lastIndexOf('.')).toLowerCase() : '')
const matches = (path, entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry)
const MEDIA_REVIEW = ['reviewed', 'pending-owner-review']

/** Validate the policy's shape (throws). */
export function checkPolicy(policy) {
  for (const key of ['include', 'exclude', 'exclude_names', 'forbidden_extensions', 'required']) {
    if (!Array.isArray(policy[key])) throw new Error(`public-export.json: "${key}" must be a list`)
  }
  if (!policy.media || !Array.isArray(policy.media.extensions) || !Array.isArray(policy.media.allow)) throw new Error('public-export.json: "media" needs "extensions" and "allow" lists')
  for (const e of [...policy.include, ...policy.exclude]) {
    if (typeof e !== 'string' || !e || e.startsWith('/') || e.includes('*') || e.split('/').includes('..')) throw new Error(`public-export.json: entry ${JSON.stringify(e)} must be a plain repository path (no globs, no ..)`)
  }
  for (const m of policy.media.allow) {
    if (!m || typeof m !== 'object' || typeof m.path !== 'string') throw new Error('public-export.json: every media entry is { path, sha256, review, why } for one file')
    if (!m.path || m.path.endsWith('/') || m.path.includes('*') || m.path.startsWith('/') || m.path.split('/').includes('..')) throw new Error(`public-export.json: media entry ${JSON.stringify(m.path)} must name one file (no folder, no glob)`)
    if (!/^[0-9a-f]{64}$/.test(m.sha256 ?? '')) throw new Error(`public-export.json: media entry ${m.path} needs the sha256 of the reviewed content`)
    if (!MEDIA_REVIEW.includes(m.review)) throw new Error(`public-export.json: media entry ${m.path}: review must be one of ${MEDIA_REVIEW.join(', ')}`)
  }
  if (policy.include.some((e) => e === 'docs/' || e === './' || e === '')) throw new Error('public-export.json: docs/ is never included wholesale; name each public document')
  checkAllowList(policy.allow)
  return policy
}

/** Whether a repository path is exported under a policy, and why not (pure; content checks come in planExport). */
export function exported(path, policy) {
  const segs = path.split('/')
  const base = segs[segs.length - 1]
  if (!policy.include.some((e) => matches(path, e))) return { ok: false, why: 'not in the include list' }
  const ex = policy.exclude.find((e) => matches(path, e))
  if (ex) return { ok: false, why: `excluded (${ex})` }
  for (const n of policy.exclude_names) {
    if (n.endsWith('/')) { if (segs.slice(0, -1).includes(n.slice(0, -1))) return { ok: false, why: `excluded folder name (${n})` } }
    else if (n.endsWith('.')) { if (base.startsWith(n) && !(policy.keep_env_example && base === '.env.example')) return { ok: false, why: `excluded name (${n}*)` } }
    else if (base === n) return { ok: false, why: `excluded name (${n})` }
  }
  const x = ext(path)
  if (policy.forbidden_extensions.includes(x)) return { ok: false, why: `forbidden file type (${x})` }
  if (policy.media.extensions.includes(x) && !policy.media.allow.some((m) => m.path === path)) return { ok: false, why: `media not explicitly reviewed (${x})` }
  return { ok: true, why: null }
}

const isDataRef = (p) => !p.endsWith('.md')

/** References from exported files that the export would break (pure apart from `read`). */
export function checkReferences(files, tracked, read, policy) {
  const exportedSet = new Set(files)
  const trackedSet = new Set(tracked)
  const isPrefixOf = (set, p) => { const pre = p.replace(/\/$/, '') + '/'; for (const f of set) if (f.startsWith(pre)) return true; return false }
  const packages = policy.packages ?? []
  const known = policy.known_unexported_references ?? []
  const broken = []
  const docPointers = []
  const unresolved = []
  const classify = (candidates) => {
    if (candidates.some((c) => exportedSet.has(c))) return 'ok'
    if (candidates.some((c) => trackedSet.has(c))) return 'excluded'
    if (candidates.some((c) => isPrefixOf(exportedSet, c))) return 'ok'
    if (candidates.some((c) => isPrefixOf(trackedSet, c))) return 'excluded'
    return 'absent'
  }
  for (const f of files) {
    // the policy names what is left out on purpose; those names are not dependencies
    if (f === POLICY_PATH) continue
    const buf = read(f)
    if (!looksText(buf)) continue
    const text = buf.toString('utf8')
    const push = (list, item) => { if (!known.some((k) => k.from === f && k.missing === item.missing)) list.push(item) }
    if (f.endsWith('.md')) {
      for (const l of markdownLinks(f, text)) {
        if (l.target === null) { push(broken, { from: f, missing: l.raw, why: 'Markdown link climbs out of the repository' }); continue }
        const c = classify([l.target])
        if (c !== 'ok') push(broken, { from: f, missing: l.target, why: c === 'excluded' ? 'Markdown link to a file the export leaves out' : 'Markdown link to nothing in the commit' })
      }
      continue
    }
    if (isCode(f)) {
      for (const s of codeSpecifiers(text)) {
        const cands = specifierCandidates(f, s)
        const c = classify(cands)
        if (c === 'excluded') push(broken, { from: f, missing: cands.find((x) => trackedSet.has(x)) ?? cands[0], why: 'module import of a file the export leaves out' })
        else if (c === 'absent') unresolved.push({ from: f, specifier: s })
      }
    }
    for (const lit of pathLiterals(text)) {
      const cands = literalCandidates(f, lit, packages)
      if (classify(cands) !== 'excluded') continue
      const missing = cands.find((x) => trackedSet.has(x)) ?? cands.find((x) => isPrefixOf(trackedSet, x)) ?? lit
      if (isDataRef(lit)) push(broken, { from: f, missing, why: 'quoted path to a file the export leaves out' })
      else docPointers.push({ from: f, missing })
    }
  }
  const dedupe = (list) => [...new Map(list.map((x) => [JSON.stringify(x), x])).values()]
  return { broken: dedupe(broken), docPointers: dedupe(docPointers), unresolved: dedupe(unresolved) }
}

/** The plan for a commit's tree (pure apart from `read`). */
export function planExport(tree, policy, read, { markers = [] } = {}) {
  const files = []
  const skipped = []
  const findings = []
  const hashes = {}
  const mediaProblems = []
  const mediaPending = []
  const mediaByPath = new Map(policy.media.allow.map((m) => [m.path, m]))
  for (const e of tree) {
    const v = exported(e.path, policy)
    if (!v.ok) { skipped.push({ path: e.path, why: v.why }); continue }
    files.push(e.path)
    const buf = read(e.path)
    if (!Buffer.isBuffer(buf)) throw new Error(`${e.path}: could not be read; the export stops (nothing is skipped unscanned)`)
    hashes[e.path] = sha256(buf)
    const media = mediaByPath.get(e.path)
    if (media) {
      // a reviewed media file is exported only with the exact content that was reviewed
      if (media.sha256 !== hashes[e.path]) mediaProblems.push({ path: e.path, why: 'content differs from the reviewed sha256 (review it again)' })
      else if (media.review !== 'reviewed') mediaPending.push({ path: e.path, review: media.review, why: media.why ?? null })
    } else if (!looksText(buf)) {
      // a binary is not text-scanned, so it is exported only as an exactly reviewed media entry
      mediaProblems.push({ path: e.path, why: 'binary file that is not a reviewed media entry (path + sha256)' })
    }
    if (looksText(buf)) findings.push(...scanText(e.path, buf.toString('utf8'), { allow: policy.allow ?? [], sha256: hashes[e.path], markers }))
  }
  // entries naming nothing exported are harmless (nothing is written for them) but listed, so the policy stays tidy
  const mediaStale = policy.media.allow.filter((m) => !files.includes(m.path)).map((m) => m.path)
  const refs = checkReferences(files, tree.map((e) => e.path), read, policy)
  const missingRequired = policy.required.filter((r) => !files.includes(r))
  return { files, skipped, findings, hashes, refs, missingRequired, mediaProblems, mediaPending, mediaStale }
}

/** Where a path really lands once symbolic links are resolved: the real path of its nearest existing ancestor, with
 *  the parts that do not exist yet appended. */
export function landingPath(p) {
  let cur = resolve(p)
  const rest = []
  while (!existsSync(cur)) {
    const parent = dirname(cur)
    if (parent === cur) break
    rest.unshift(basename(cur))
    cur = parent
  }
  return join(realpathSync(cur), ...rest)
}

const within = (inner, outer) => inner === outer || inner.startsWith(outer + sep)

/** Throws when the report would land inside the export folder (symbolic links resolved on both sides). */
export function checkReportPlacement(report, out) {
  if (!report || !out) return
  if (within(landingPath(report), landingPath(out))) throw new Error('--report must not land inside --out (the tree carries only the exported files)')
}

/** Write the report as a new file, checking its real location against the export folder again just before writing. */
export function writeReport(file, report, out) {
  mkdirSync(dirname(resolve(file)), { recursive: true })
  checkReportPlacement(file, out)
  const real = join(realpathSync(dirname(resolve(file))), basename(resolve(file)))
  if (out && existsSync(out) && within(real, realpathSync(out))) throw new Error('--report resolves inside --out; not written')
  writeFileSync(real, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  return real
}

/** The target folder, made safely: its parent must exist and is resolved through any symbolic link; the result must
 *  lie outside the source repository; the folder itself is created with one mkdir that fails if anything is there. */
export function makeTarget(out, repo) {
  const parent = dirname(resolve(out))
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error(`the parent folder ${parent} does not exist`)
  const target = join(realpathSync(parent), basename(resolve(out)))
  const source = realpathSync(repo)
  if (within(target, source) || within(source, target)) throw new Error(`the target ${target} overlaps the source repository`)
  try { mkdirSync(target, { mode: 0o755 }) } catch (e) { throw new Error(e.code === 'EEXIST' ? `${target} already exists; name a new folder` : `cannot create ${target}: ${e.message}`) }
  return target
}

/** Write one exported file: every parent folder is created by us and checked to be a real folder inside the target
 *  (no symbolic link can redirect a write), the file is created exclusively, with its committed mode. */
export function writeExported(target, path, buf, mode) {
  const segs = path.split('/')
  let dir = target
  for (const seg of segs.slice(0, -1)) {
    dir = join(dir, seg)
    if (existsSync(dir)) { if (!lstatSync(dir).isDirectory()) throw new Error(`${dir} is not a plain folder; stopping`) } else mkdirSync(dir)
  }
  const dest = join(dir, segs[segs.length - 1])
  if (!within(realpathSync(dirname(dest)), realpathSync(target))) throw new Error(`${dest} resolves outside the target; stopping`)
  const perm = mode === '100755' ? 0o755 : 0o644
  writeFileSync(dest, buf, { flag: 'wx', mode: perm })
  chmodSync(dest, perm)
}

/** A new local repository in the target: no template (so no hooks are copied), no remote, files staged; one root commit
 *  only when an author is given. The git environment is isolated (an ambient GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
 *  cannot point it elsewhere) and git's work tree and directory are named explicitly as the target. */
export function gitInit(target, author) {
  const real = realpathSync(target)
  const run = (args, extra = {}) => {
    const r = spawnSync('git', ['-C', real, ...SAFE_GIT_OPTIONS, ...args], { env: isolatedGitEnv({ GIT_DIR: join(real, '.git'), GIT_WORK_TREE: real, ...extra }), encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`git ${args[0]} in the target failed: ${r.stderr.trim()}`)
    return r.stdout
  }
  run(['init', '-q', '--template=', '--initial-branch=main'])
  run(['add', '-A'])
  if (!author) return { initialized: true, committed: null }
  const m = /^\s*([^<>]+?)\s*<([^<>\s]+)>\s*$/.exec(author)
  if (!m) throw new Error('--git-author must look like "Name <email>"')
  const who = { GIT_AUTHOR_NAME: m[1], GIT_AUTHOR_EMAIL: m[2], GIT_COMMITTER_NAME: m[1], GIT_COMMITTER_EMAIL: m[2] }
  run(['commit', '-q', '--no-verify', '-m', 'Initial public source tree'], who)
  return { initialized: true, committed: run(['rev-parse', 'HEAD']).trim() }
}

/** The policy committed at a commit (never the working tree), with the sha256 of the blob it was read from. */
export function committedPolicy(repo, commit) {
  let buf
  try { buf = readCommittedFile(repo, commit, POLICY_PATH) } catch { throw new Error(`commit ${commit.slice(0, 12)} has no ${POLICY_PATH}; commit the policy first (an uncommitted policy is never used)`) }
  return { policy: JSON.parse(buf.toString('utf8')), sha256: sha256(buf) }
}

/** The whole export (the CLI and the tests call it). `policy` given -> used as is (tests); absent -> read from the
 *  commit being exported. Throws on unsafe input or target. */
export function runExport({ repo = REPO, policy = null, rev, write = false, out = null, markers = [], gitInitTarget = false, gitAuthor = null, log = () => {} }) {
  const commit = resolveCommit(repo, rev)
  let policySource
  if (policy) policySource = { source: 'given by the caller', path: null, sha256: null }
  else {
    const c = committedPolicy(repo, commit)
    policy = c.policy
    policySource = { source: `committed at ${commit}`, path: POLICY_PATH, sha256: c.sha256 }
  }
  checkPolicy(policy)
  const tree = listTree(repo, commit)
  const problems = treeProblems(tree)
  if (problems.length) throw new Error(`the commit's tree has entries that cannot be exported safely (the export stops): ${problems.slice(0, 10).map((p) => `${p.path}: ${p.why}`).join('; ')}`)
  const collisions = caseCollisions(tree.map((e) => e.path))
  if (collisions.length) throw new Error(`paths collide on a case-insensitive file system: ${collisions.slice(0, 5).map((g) => g.join(' / ')).join('; ')}`)
  const byPath = new Map(tree.map((e) => [e.path, e]))
  const blobs = readBlobs(repo, tree.map((e) => e.sha))
  const plan = planExport(tree, policy, (p) => blobs.get(byPath.get(p).sha), { markers })
  const secrets = plan.findings.filter((f) => f.kind === 'secret' && !f.allowed)
  const privacy = plan.findings.filter((f) => f.kind === 'privacy' && !f.allowed)
  const allowedFindings = plan.findings.filter((f) => f.allowed)
  const report = {
    source_commit: commit,
    policy: policySource,
    read_from: 'git objects of the commit (the working tree and untracked files are not read)',
    mode: write ? 'write' : 'dry-run',
    status: 'local candidate — publishing it (where, and whether as a clean new repository) is the owner\'s decision, see PUBLIC_EXPORT.md',
    history: 'not exported (no .git, no authors, no remotes)',
    counts: { tracked: tree.length, exported: plan.files.length, skipped: plan.skipped.length, secret_findings: secrets.length, privacy_findings: privacy.length, allowed_findings: allowedFindings.length, broken_references: plan.refs.broken.length, media_problems: plan.mediaProblems.length, media_pending_owner_review: plan.mediaPending.length, doc_pointers: plan.refs.docPointers.length, missing_required: plan.missingRequired.length },
    secret_findings: secrets,
    privacy_findings: privacy,
    allowed_findings: allowedFindings,
    broken_references: plan.refs.broken,
    media_problems: plan.mediaProblems,
    missing_required: plan.missingRequired,
    media_pending_owner_review: plan.mediaPending,
    media_entries_not_exported: plan.mediaStale,
    doc_pointers_to_unexported_files: plan.refs.docPointers,
    unresolved_imports: plan.refs.unresolved,
    skipped: plan.skipped,
    manifest_sha256: plan.hashes,
    exported_modes: Object.fromEntries(plan.files.map((p) => [p, byPath.get(p).mode])),
  }
  const failing = secrets.length > 0 || privacy.length > 0 || plan.refs.broken.length > 0 || plan.missingRequired.length > 0 || plan.mediaProblems.length > 0
  log(`export: ${plan.files.length} of ${tree.length} committed files ${write ? 'to export' : 'would be exported (dry run)'}; source ${commit}; policy ${policySource.sha256 ? `blob sha256 ${policySource.sha256}` : policySource.source}`)
  log(`export: ${secrets.length} likely secret(s), ${privacy.length} privacy finding(s), ${allowedFindings.length} reviewed finding(s), ${plan.refs.broken.length} broken reference(s), ${plan.mediaProblems.length} media problem(s), ${plan.missingRequired.length} missing required file(s); ${plan.mediaPending.length} media file(s) pending owner review`)
  for (const f of secrets) log(`export: SECRET ${f.rule} ${f.path}:${f.line} ${f.shape}`)
  for (const f of privacy.slice(0, 100)) log(`export: PRIVACY ${f.rule} ${f.path}:${f.line} ${f.shape}`)
  for (const b of plan.refs.broken.slice(0, 100)) log(`export: BROKEN ${b.from} -> ${b.missing} (${b.why})`)
  for (const m of plan.mediaProblems.slice(0, 100)) log(`export: MEDIA ${m.path} (${m.why})`)
  for (const r of plan.missingRequired) log(`export: REQUIRED ${r} is not exported`)
  if (plan.refs.docPointers.length) log(`export: ${plan.refs.docPointers.length} pointer(s) from code to unexported documents (listed in the report; not failing)`)
  if (!write) return { report, failing, target: null }
  if (failing) return { report, failing, target: null, refused: 'fix the findings first (nothing was written)' }
  const target = makeTarget(out, repo)
  for (const p of plan.files) writeExported(target, p, blobs.get(byPath.get(p).sha), byPath.get(p).mode)
  const bad = plan.files.filter((p) => sha256(readFileSync(join(target, p))) !== plan.hashes[p])
  if (bad.length) throw new Error(`${bad.length} file(s) differ after writing: ${bad.slice(0, 5).join(', ')}`)
  report.integrity = `all ${plan.files.length} files read back and match the sha256 of their committed blobs`
  if (gitInitTarget) report.git = gitInit(target, gitAuthor)
  return { report, failing, target }
}

export function main(argv = process.argv.slice(2), { log = (l) => console.log(l), error = (l) => console.error(l) } = {}) {
  let cli
  try {
    cli = parseCli(argv, { flags: ['--write', '--git-init'], values: ['--commit', '--repo', '--out', '--report', '--markers', '--git-author'] })
    if (!cli.values['--commit']) throw new Error('--commit REV is required (name the commit to export)')
    if (cli.flags.has('--write') !== Boolean(cli.values['--out'])) throw new Error('--write and --out go together (--out: a folder that does not exist yet)')
    if (cli.flags.has('--git-init') && !cli.flags.has('--write')) throw new Error('--git-init needs --write')
    if (cli.values['--git-author'] && !cli.flags.has('--git-init')) throw new Error('--git-author needs --git-init')
    if (cli.values['--report']) {
      if (existsSync(resolve(cli.values['--report']))) throw new Error(`${resolve(cli.values['--report'])} already exists; name a new file`)
      checkReportPlacement(cli.values['--report'], cli.values['--out'])
    }
  } catch (e) { error(`export: ${e.message}`); return 2 }
  let result
  try {
    const markers = cli.values['--markers'] ? parseMarkers(readFileSync(resolve(cli.values['--markers']), 'utf8')) : []
    result = runExport({ repo: cli.values['--repo'] ? resolve(cli.values['--repo']) : REPO, rev: cli.values['--commit'], write: cli.flags.has('--write'), out: cli.values['--out'], markers, gitInitTarget: cli.flags.has('--git-init'), gitAuthor: cli.values['--git-author'] ?? null, log })
  } catch (e) { error(`export: ${e.message}`); return 2 }
  if (result.refused) error(`export: refused — ${result.refused}`)
  if (result.target) log(`export: wrote ${result.report.counts.exported} files to ${result.target}; ${result.report.integrity}${result.report.git ? `; git: ${result.report.git.committed ? `root commit ${result.report.git.committed}` : 'initialized, files staged, no commit'}` : ''}`)
  if (cli.values['--report']) {
    try { log(`export: report written to ${writeReport(cli.values['--report'], result.report, result.target ?? cli.values['--out'])}`) } catch (e) { error(`export: ${e.message}`); return 2 }
  }
  return result.failing ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main())
