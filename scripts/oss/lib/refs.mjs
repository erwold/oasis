// What an exported file points at, so the export can refuse a tree whose files depend on something it leaves out
// (pure functions over text; nothing is read here).
//
//   markdownLinks       relative links of a Markdown file ([text](target), [text]: target)
//   codeSpecifiers      relative module specifiers of JS/TS (import / export from, import(), require(), new URL())
//   pathLiterals        quoted repository-looking paths with a file extension ('scripts/x.ts', '../docs/a.json'),
//                       and path.join-style pieces starting at 'docs' ('docs', 'demos', 'a.json')

const posix = {
  normalize(parts) {
    const out = []
    for (const seg of parts) {
      if (seg === '..') { if (out.length === 0) return null; out.pop() } else if (seg !== '.' && seg !== '') out.push(seg)
    }
    return out.join('/')
  },
}

export function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

/** `target` relative to the folder `dir` -> a repository path, or null when it climbs out of the repository. */
export function joinRepo(dir, target) {
  return posix.normalize([...(dir ? dir.split('/') : []), ...target.split('/')])
}

export function markdownLinks(path, text) {
  const dir = dirOf(path)
  const raw = [...text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g), ...text.matchAll(/^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm)].map((m) => m[1])
  const out = []
  for (const r of raw) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('#') || r.startsWith('//')) continue
    const t = decodeURIComponentSafe(r.split('#')[0].split('?')[0])
    if (!t) continue
    out.push({ raw: r, target: t.startsWith('/') ? joinRepo('', t.slice(1)) : joinRepo(dir, t) })
  }
  return out
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s) } catch { return s }
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/

export function isCode(path) {
  return CODE_EXT.test(path)
}

export function codeSpecifiers(text) {
  const out = new Set()
  const patterns = [
    /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s+['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
    /\bnew URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
  ]
  for (const re of patterns) for (const m of text.matchAll(re)) out.add(m[1])
  return [...out]
}

/** The repository paths a relative specifier may name, most likely first (a TS file importing './x.ts', './x.js'
 *  meaning x.ts, './x' meaning x.ts / x.tsx / x/index.ts ...). */
export function specifierCandidates(fromPath, spec) {
  const base = joinRepo(dirOf(fromPath), spec.split('?')[0])
  if (base === null) return []
  const c = [base]
  const noJs = base.replace(/\.(?:[cm]?js|jsx)$/, '')
  for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts']) c.push(noJs + ext, base + ext)
  for (const idx of ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.cjs']) c.push(`${base}/${idx}`)
  return [...new Set(c)]
}

const DATA_EXT = 'ts|tsx|mts|cts|js|mjs|cjs|jsx|json|jsonl|py|sh|html|css|csv|txt|png|jpg|jpeg|webp|gif|svg|woff2?|ttf|key|pem|crt|sql|yaml|yml|toml|md'

/** Quoted path literals with an extension, and join('…', 'docs', 'x', 'y.json')-style pieces. */
export function pathLiterals(text) {
  const out = new Set()
  const lit = new RegExp(`['"\`]((?:\\.{1,2}/)*[A-Za-z0-9_@.-]+(?:/[A-Za-z0-9_@.-]+)*\\.(?:${DATA_EXT}))['"\`]`, 'g')
  for (const m of text.matchAll(lit)) if (m[1].includes('/')) out.add(m[1])
  const bare = new RegExp(`(?:^|[\\s(=,:])((?:\\.{1,2}/)*(?:docs|scripts|tests|e2e|src|fixtures)/[A-Za-z0-9_@./-]+\\.(?:${DATA_EXT}))\\b`, 'gm')
  for (const m of text.matchAll(bare)) out.add(m[1])
  for (const m of text.matchAll(/['"]docs['"]((?:\s*,\s*['"][A-Za-z0-9_@.-]+['"])+)/g)) {
    const pieces = [...m[1].matchAll(/['"]([A-Za-z0-9_@.-]+)['"]/g)].map((x) => x[1])
    out.add(['docs', ...pieces].join('/'))
  }
  return [...out]
}

/** Folders a path literal may be relative to: the file's own folder, its package folder, the repository root. */
export function literalCandidates(fromPath, lit, packages) {
  const c = new Set()
  const add = (p) => { if (p) c.add(p) }
  add(joinRepo(dirOf(fromPath), lit))
  const pkg = packages.find((p) => fromPath.startsWith(p + '/'))
  if (pkg) add(joinRepo(pkg, lit))
  for (const p of packages) add(joinRepo(p, lit))
  add(joinRepo('', lit))
  return [...c]
}
