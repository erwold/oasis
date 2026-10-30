#!/usr/bin/env node
// Secret and privacy scan of a repository's committed objects, in one of two separate modes:
//
//   node scripts/oss/scan-secrets.mjs --snapshot REV  [--repo DIR] [--report FILE] [--markers FILE] [--strict-privacy]
//   node scripts/oss/scan-secrets.mjs --history REV   [--all-refs] [--repo DIR] [--report FILE] [--markers FILE] [--strict-privacy]
//
// --snapshot REV  the files of one commit (what a history-less export of that commit could contain, before the
//                 export's own allowlist narrows it down)
// --history REV   every blob reachable from REV (every version of every file ever committed on that line), plus the
//                 commit metadata (author / committer identities and messages); --all-refs widens it to every ref
// --markers FILE  a local file of private literals (user name, real names, private hosts), one per line; keep it
//                 outside the repository. Matches are reported as "marker #N", never by their text.
// The reviewed allowances (exact path + rule + sha256) come from scripts/oss/public-export.json as committed at REV;
// a commit without it is scanned with no allowance. The working tree is never read.
// --report FILE   write the JSON report there (a new file; refused when it exists). Keep reports outside the
//                 repository: they name paths and commits.
//
// Output never contains a matched value: rule, path, line, blob, commit and a redacted shape only. Nothing is
// written to the repository, nothing is validated against a provider, nothing touches the network.
// Exit 0 no unreviewed secret (and, with --strict-privacy, no unreviewed privacy marker); 1 findings; 2 bad usage.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { parseCli } from './lib/args.mjs'
import { checkAllowList, looksText, parseMarkers, redact, scanText, PRIVACY_RULES, SECRET_RULES } from './lib/scan.mjs'
import { git, listTree, readBlobs, readCommittedFile, resolveCommit } from './lib/git.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** File names that should never be committed, whatever they contain (reported, not failing by themselves). */
const RISKY_NAME = /(^|\/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|p12|pfx|p8|mobileprovision|keychain|keystore|jks|sqlite3?|db|har|log)|credentials?[^/]*\.json|auth\.json|token[^/]*\.json|\.netrc|\.npmrc|\.pypirc|\.oasis-code\/[^/]*|\.claude\/[^/]*)$/i

export function riskyName(path) {
  if (/(^|\/)\.env\.example$/.test(path)) return false
  return RISKY_NAME.test(path)
}

/** Scan a list of { path, sha } against the blobs; returns findings with blob ids (pure apart from `read`). */
export function scanEntries(entries, read, { allow = [], markers = [] } = {}) {
  const findings = []
  let binary = 0
  const done = new Map()
  for (const e of entries) {
    if (riskyName(e.path)) findings.push({ kind: 'risky-file', rule: 'risky-file-name', path: e.path, line: null, shape: null, blob: e.sha })
    const buf = read(e.sha)
    if (!looksText(buf)) { binary++; continue }
    const key = `${e.sha}\u0000${e.path}`
    if (done.has(key)) continue
    done.set(key, true)
    const fileSha = sha256(buf)
    for (const f of scanText(e.path, buf.toString('utf8'), { allow, sha256: fileSha, markers })) findings.push({ ...f, blob: e.sha })
  }
  return { findings, binary }
}

/** Every blob reachable from the given revisions, each with one path it was committed under (the first seen). */
export function reachableBlobs(repo, revs) {
  const lines = git(repo, ['rev-list', '--objects', '--no-object-names', ...revs]).toString().split('\n').filter(Boolean)
  const types = git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: lines.join('\n') + '\n' }).toString().split('\n').filter(Boolean)
  const blobs = new Set(types.filter((l) => l.endsWith(' blob')).map((l) => l.split(' ')[0]))
  // names: rev-list --objects with names gives the path of the first sighting
  const named = git(repo, ['rev-list', '--objects', ...revs]).toString().split('\n').filter(Boolean)
  const out = []
  const seen = new Set()
  for (const l of named) {
    const sp = l.indexOf(' ')
    if (sp < 0) continue
    const sha = l.slice(0, sp)
    if (!blobs.has(sha) || seen.has(sha)) continue
    seen.add(sha)
    out.push({ sha, path: l.slice(sp + 1) })
  }
  return out
}

/** The commit metadata of a range: identities and messages, scanned like text (paths are "commit:<id>"). */
export function scanCommits(repo, revs, { markers = [] } = {}) {
  const raw = git(repo, ['log', '--format=%H%x00%an <%ae>%x00%cn <%ce>%x00%B%x01', ...revs]).toString('utf8')
  const findings = []
  const identities = new Map()
  for (const rec of raw.split('\x01')) {
    const parts = rec.replace(/^\n/, '').split('\x00')
    if (parts.length < 4) continue
    const [id, author, committer, body] = parts
    for (const who of [author, committer]) identities.set(who, (identities.get(who) ?? 0) + 1)
    for (const f of scanText(`commit:${id}`, `${author}\n${committer}\n${body}`, { markers })) findings.push({ ...f, commit: id, line: null })
  }
  // identities: counted per rule and redacted (the history carries them; whether to publish it is the owner's call)
  const idSummary = [...identities].map(([who, n]) => {
    const m = /<([^>]*)>/.exec(who)
    const email = m ? m[1] : ''
    const personal = PRIVACY_RULES.find((r) => r.id === 'personal-email').re.test(email)
    return { identity: redact(who), commits: n, personal_email: personal }
  })
  return { findings, identities: idSummary }
}

/** The first commit (oldest, on the scanned revisions) that added a blob, or null. */
function introducedBy(repo, revs, blob) {
  try {
    const out = git(repo, ['log', '--format=%H', '--reverse', `--find-object=${blob}`, ...revs]).toString().split('\n').filter(Boolean)
    return out[0] ?? null
  } catch { return null }
}

export function runScan({ repo = REPO, mode, rev, allRefs = false, allow = [], markers = [] }) {
  const commit = resolveCommit(repo, rev)
  const report = { mode, source_commit: commit, scope: null, rules: { secret: SECRET_RULES.map((r) => r.id), privacy: [...PRIVACY_RULES.map((r) => r.id), ...(markers.length ? ['private-marker'] : [])] } }
  if (mode === 'snapshot') {
    const tree = listTree(repo, commit)
    const nonFiles = tree.filter((e) => e.type !== 'blob' || e.mode === '120000')
    const blobs = readBlobs(repo, tree.filter((e) => e.type === 'blob').map((e) => e.sha))
    const { findings, binary } = scanEntries(tree.filter((e) => e.type === 'blob'), (s) => blobs.get(s), { allow, markers })
    report.scope = `the ${tree.length} entries of commit ${commit}'s tree (git objects; the working tree is not read)`
    report.counts = { entries: tree.length, binary_unscanned: binary, symlinks_or_gitlinks: nonFiles.length }
    report.non_file_entries = nonFiles.map((e) => ({ path: e.path, mode: e.mode }))
    report.findings = findings
  } else {
    const revs = allRefs ? ['--all'] : [commit]
    const entries = reachableBlobs(repo, revs)
    const blobs = readBlobs(repo, entries.map((e) => e.sha))
    const { findings, binary } = scanEntries(entries, (s) => blobs.get(s), { allow, markers })
    const snapshot = new Set(listTree(repo, commit).map((e) => e.sha))
    const intro = new Map()
    for (const f of findings) {
      if (!intro.has(f.blob)) intro.set(f.blob, introducedBy(repo, revs, f.blob))
      f.first_commit = intro.get(f.blob)
      f.in_snapshot = snapshot.has(f.blob)
    }
    const meta = scanCommits(repo, revs, { markers })
    report.scope = allRefs ? 'every blob and commit reachable from every ref' : `every blob and commit reachable from ${commit}`
    report.counts = { commits: Number(git(repo, ['rev-list', '--count', ...revs]).toString().trim()), blobs: entries.length, binary_unscanned: binary }
    report.findings = [...findings, ...meta.findings]
    report.identities = meta.identities
  }
  const unallowed = (kind) => report.findings.filter((f) => f.kind === kind && !f.allowed)
  report.counts.secret = unallowed('secret').length
  report.counts.privacy = unallowed('privacy').length
  report.counts.risky_file = unallowed('risky-file').length
  report.counts.allowed = report.findings.filter((f) => f.allowed).length
  return report
}

/** The reviewed allowances committed at a commit (never the working tree); none when the policy is absent there. */
export function committedAllow(repo, commit) {
  let buf
  try { buf = readCommittedFile(repo, commit, 'scripts/oss/public-export.json') } catch { return [] }
  return checkAllowList(JSON.parse(buf.toString('utf8')).allow)
}

function where(f) {
  const loc = f.line ? `${f.path}:${f.line}` : f.path
  const extra = [f.blob ? `blob ${f.blob.slice(0, 12)}` : null, f.first_commit ? `first ${f.first_commit.slice(0, 12)}` : null, f.commit ? `commit ${f.commit.slice(0, 12)}` : null, f.in_snapshot === false ? 'history only' : null].filter(Boolean)
  return `${loc}${extra.length ? ` (${extra.join(', ')})` : ''}${f.shape ? ` ${f.shape}` : ''}`
}

function main() {
  let cli
  try {
    cli = parseCli(process.argv.slice(2), { flags: ['--all-refs', '--strict-privacy'], values: ['--snapshot', '--history', '--repo', '--report', '--markers'] })
    if (Boolean(cli.values['--snapshot']) === Boolean(cli.values['--history'])) throw new Error('give exactly one of --snapshot REV and --history REV')
    if (cli.flags.has('--all-refs') && !cli.values['--history']) throw new Error('--all-refs goes with --history')
  } catch (e) { console.error(`scan: ${e.message}`); process.exit(2) }
  let report
  try {
    const repo = cli.values['--repo'] ? resolve(cli.values['--repo']) : REPO
    const rev = cli.values['--snapshot'] ?? cli.values['--history']
    const allow = committedAllow(repo, resolveCommit(repo, rev))
    const markers = cli.values['--markers'] ? parseMarkers(readFileSync(resolve(cli.values['--markers']), 'utf8')) : []
    const mode = cli.values['--snapshot'] ? 'snapshot' : 'history'
    report = runScan({ repo, mode, rev, allRefs: cli.flags.has('--all-refs'), allow, markers })
    report.allowances = allow.length ? `${allow.length} exact entr(ies) from scripts/oss/public-export.json at ${report.source_commit}` : 'none'
  } catch (e) { console.error(`scan: ${e.message}`); process.exit(2) }
  const c = report.counts
  console.log(`scan (${report.mode}): ${report.scope}`)
  console.log(`scan: ${c.secret} likely secret(s), ${c.privacy} privacy marker(s), ${c.risky_file} risky file name(s), ${c.allowed} reviewed finding(s); ${c.binary_unscanned} binary blob(s) not text-scanned`)
  for (const f of report.findings.filter((x) => !x.allowed)) {
    if (f.kind === 'secret') console.log(`scan: SECRET ${f.rule} ${where(f)}`)
  }
  for (const f of report.findings.filter((x) => !x.allowed && x.kind !== 'secret').slice(0, 200)) console.log(`scan: ${f.kind} ${f.rule} ${where(f)}`)
  if (report.identities) console.log(`scan: ${report.identities.length} commit identit(ies), ${report.identities.filter((i) => i.personal_email).length} with a personal e-mail domain (history carries them)`)
  if (cli.values['--report']) {
    const r = resolve(cli.values['--report'])
    if (existsSync(r)) { console.error(`scan: ${r} already exists; name a new file`); process.exit(2) }
    mkdirSync(dirname(r), { recursive: true })
    writeFileSync(r, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(`scan: report written to ${r}`)
  }
  process.exit(c.secret > 0 || (cli.flags.has('--strict-privacy') && c.privacy > 0) ? 1 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
