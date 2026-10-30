/** The plugins both share viewer builds use — the offline file's (vite.share.config.ts) and the live link page's
 *  (vite.live-share.config.ts): the app's modules that would reach the harness or the page's storage replaced by the
 *  in-memory stand-ins of src/share/viewer/offline (a guard fails the build if a forbidden module still enters the
 *  bundle), KaTeX's woff2 faces only, and the emitted script and stylesheet checked: no network call site but the ones
 *  a build allows, zod jitless before zod evaluates, no non-data URL in the stylesheet. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'
import ts from 'typescript'
import { FORBIDDEN, STAND_INS } from './src/share/viewer/offline/standIns.ts'

const SRC = resolve(import.meta.dirname, 'src')
const OFFLINE = join(SRC, 'share/viewer/offline')

const STAND_IN_FILES: Record<string, string> = Object.fromEntries(Object.entries(STAND_INS).map(([m, f]) => [m, join(OFFLINE, f)]))

const stem = (file: string) => file.replace(/\.(tsx?|jsx?)$/, '')

/** The stand-ins in place of the app's modules, and the guard; `forbidden` adds modules of a build's own. */
export function offline(name: string, extraForbidden: readonly string[] = []): Plugin {
  const seen = new Set<string>()
  // who first asked for each module (said when the guard refuses one)
  const asker = new Map<string, string>()
  const forbidden = [...FORBIDDEN, ...extraForbidden]
  return {
    name: 'oasis-share-offline',
    enforce: 'pre',
    resolveId(source, importer) {
      // KaTeX's HTML (rehype-katex) parsed by the package's own DOM-free build (hast-util-from-html, parse5 — what it
      // runs on deno and in workers): its browser build parses through a <template>'s innerHTML, which makes the page
      // parse KaTeX's inline style ATTRIBUTES — each a CSP style-src-attr violation under the viewer's policy.
      // The tree is the same; React then sets those styles through the CSSOM, which the policy allows.
      if (source === 'hast-util-from-html-isomorphic') return join(import.meta.dirname, 'node_modules/hast-util-from-html-isomorphic/index.js')
      if (!importer || !source.startsWith('.')) return null
      const target = resolve(dirname(importer), source)
      if (!target.startsWith(SRC + '/')) return null
      const key = stem(target.slice(SRC.length + 1))
      if (!asker.has(key)) asker.set(key, stem(importer.slice(SRC.length + 1)))
      // the stand-ins import the real modules' TYPES only (erased); a stand-in never resolves to another stand-in
      if (importer.startsWith(OFFLINE)) return null
      return STAND_IN_FILES[key] ?? null
    },
    load(id) {
      const file = id.split('?')[0]!
      // never the DOM-template parser (see resolveId): a regression would bring back style-src-attr violations
      if (/hast-util-from-html-isomorphic\/lib\/browser\.js$/.test(file)) this.error('the viewer must not bundle hast-util-from-html-isomorphic/lib/browser.js')
      if (file.startsWith(SRC + '/')) seen.add(stem(file.slice(SRC.length + 1)))
      // KaTeX's stylesheet: each face's woff2 only
      if (/katex\/dist\/katex(\.min)?\.css$/.test(file)) {
        const css = readFileSync(file, 'utf8')
        const kept = css.replace(/,\s*url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '')
        if (/\.(?:woff|ttf)\)/.test(kept)) this.error('a KaTeX face keeps a woff/ttf source')
        return kept
      }
      return null
    },
    buildEnd() {
      const bad = forbidden.filter((m) => seen.has(m))
      if (bad.length) this.error(`${name} must not bundle: ${bad.map((m) => `${m} (from ${asker.get(m) ?? '?'})`).join(', ')}`)
    },
  }
}

const NETWORK_GLOBALS = new Set(['fetch', 'XMLHttpRequest', 'EventSource', 'WebSocket', 'Worker', 'SharedWorker', 'importScripts'])
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'navigator', 'top', 'parent'])

/** The emitted script's network call sites, read from its syntax tree (not its text): a call or construction of a
 *  global network API by name (`fetch(…)`, `new WebSocket(…)`), the same through a global object (`window.fetch`,
 *  `navigator.sendBeacon`), and any `import(…)`. A method of the script's own (KaTeX's parser has `fetch()`, called as
 *  `this.fetch()`) is none of these. */
export function networkCallSites(js: string): string[] {
  const file = ts.createSourceFile('share-viewer.js', js, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  const found: string[] = []
  const target = (e: ts.Expression): string | null => {
    if (ts.isIdentifier(e)) return NETWORK_GLOBALS.has(e.text) ? e.text : null
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && GLOBAL_OBJECTS.has(e.expression.text)
      && (NETWORK_GLOBALS.has(e.name.text) || e.name.text === 'sendBeacon')) return `${e.expression.text}.${e.name.text}`
    return null
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push('import()')
      else { const t = target(node.expression); if (t) found.push(`${t}()`) }
    } else if (ts.isNewExpression(node)) {
      const t = target(node.expression)
      if (t) found.push(`new ${t}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

/** A global network API named anywhere but as a call (`const f = fetch`, `globalThis['fetch']`): a way around the call
 *  site count. Only identifiers and plain property names are read; a string key naming one is refused too. */
export function networkReferences(js: string): string[] {
  const file = ts.createSourceFile('viewer.js', js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && NETWORK_GLOBALS.has(node.text)) {
      const p = node.parent
      const called = (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === node
      const member = ts.isPropertyAccessExpression(p) && p.name === node && !GLOBAL_OBJECTS.has((p.expression as ts.Identifier).text ?? '')
      const declared = (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === node
      const viaGlobal = ts.isPropertyAccessExpression(p) && p.name === node && ts.isIdentifier(p.expression) && GLOBAL_OBJECTS.has(p.expression.text)
        && (ts.isCallExpression(p.parent) || ts.isNewExpression(p.parent)) && p.parent.expression === p
      if (!called && !member && !declared && !viaGlobal) found.push(node.text)
    }
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && (NETWORK_GLOBALS.has(node.argumentExpression.text) || node.argumentExpression.text === 'sendBeacon')) found.push(`[${node.argumentExpression.text}]`)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

export interface ScriptCheck {
  /** the network call sites the script may hold, by their name as networkCallSites says them (`fetch()`), and how many */
  allowed: Readonly<Record<string, number>>
  /** escape what would end an inline <script> element (the offline file carries the script inline) */
  inline: boolean
  /** also refuse a network API named outside a call (`const f = fetch`): the live page's guard around its one call */
  references: boolean
}

/** The script and stylesheet of a viewer build, checked (and, for an inline one, escaped); its measures written beside. */
export function checkedOutput(outDir: string, base: string, check: ScriptCheck): Plugin {
  return {
    name: 'oasis-share-checked-output',
    apply: 'build',
    writeBundle() {
      const jsPath = join(outDir, `${base}.js`)
      const cssPath = join(outDir, `${base}.css`)
      if (!existsSync(jsPath) || !existsSync(cssPath)) this.error(`the viewer build wrote no ${base}.js / ${base}.css`)
      let js = readFileSync(jsPath, 'utf8')
      const css = readFileSync(cssPath, 'utf8')
      if (check.inline) {
        // `</script` and `<!--` occur only inside strings, regexes or comments of a bundle: `<\/` and `<\!--` mean the same there
        js = js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
        if (/<\/script|<!--/i.test(js)) this.error('the viewer script still holds </script or <!--')
        if (/<\/style/i.test(css)) this.error('the viewer stylesheet holds </style')
      }
      // zod's JIT off before zod evaluates: the first mention of its global config in the script is the viewer's own
      // jitless assignment (src/share/viewer/jitless.ts), ahead of zod's `??=` and of every schema the contract builds
      const zodConfig = js.indexOf('__zod_globalConfig')
      if (zodConfig < 0 || !/^__zod_globalConfig[^;]{0,120}jitless/.test(js.slice(zodConfig))) this.error('the viewer does not set zod jitless before zod evaluates')
      const evalSites = (js.match(/(?<![.\w$])(?:new\s+)?Function\s*\(|(?<![.\w$])eval\s*\(/g) ?? []).length
      const calls = networkCallSites(js)
      const counts = new Map<string, number>()
      for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1)
      const over = [...counts].filter(([c, n]) => n > (check.allowed[c] ?? 0)).map(([c, n]) => `${c} ×${n}`)
      if (over.length) this.error(`the viewer script holds network call sites: ${over.join(', ')}`)
      const missing = Object.entries(check.allowed).filter(([c, n]) => (counts.get(c) ?? 0) !== n).map(([c, n]) => `${c} (want ${n}, has ${counts.get(c) ?? 0})`)
      if (missing.length) this.error(`the viewer script's allowed call sites are not as counted: ${missing.join(', ')}`)
      const refs = check.references ? networkReferences(js) : []
      if (refs.length) this.error(`the viewer script names a network API outside a call: ${[...new Set(refs)].join(', ')}`)
      const urls = css.match(/url\((?!["']?data:)[^)]*\)/g) ?? []
      if (urls.length) this.error(`the viewer stylesheet references non-data URLs: ${urls.slice(0, 5).join(', ')}`)
      const fonts = css.match(/url\(["']?data:font\/[a-z0-9.+-]+/g) ?? []
      if (fonts.some((f) => !f.endsWith('font/woff2'))) this.error('the viewer stylesheet embeds a font other than woff2')
      writeFileSync(jsPath, js)
      const sha = (s: string) => createHash('sha256').update(s).digest('base64')
      const measures = check.inline
        ? { js_bytes: Buffer.byteLength(js), css_bytes: Buffer.byteLength(css), woff2_faces: fonts.length, eval_sites_present_unreached_with_jitless: evalSites }
        : { js_bytes: Buffer.byteLength(js), css_bytes: Buffer.byteLength(css), js_sha256: sha(js), css_sha256: sha(css), woff2_faces: fonts.length,
            network_call_sites: Object.fromEntries(counts), eval_sites_present_unreached_with_jitless: evalSites }
      writeFileSync(join(outDir, `${base}.json`), JSON.stringify(measures, null, 1))
    },
  }
}
