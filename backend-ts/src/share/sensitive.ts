/** Tool calls whose content a share snapshot always withholds, whatever its options: what a credential, key or
 *  configuration file held, an environment dump, a command that prints a token. Decided from the call's own
 *  allowlisted metadata (path, command, cwd, url) — never by reading any file. The tool's name and status stay. */

import { withAliases } from './path_alias.ts'

export interface ToolTarget { path?: string | null; command?: string | null; cwd?: string | null; url?: string | null }

const SENSITIVE_BASENAME = [
  /^\.env(?:\..*)?$/i, /^\.envrc$/i, /^.*\.env$/i,
  /\.(?:pem|key|p12|pfx|p8|keystore|jks|kdbx|ppk|asc|gpg|ovpn|mobileprovision)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
  /^(?:credentials|credentials\.json|credentials\.ya?ml|auth\.json|token\.json|tokens\.json|secrets?(?:\.[a-z]+)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.yarnrc(?:\.yml)?|\.git-credentials|\.dockercfg|kubeconfig|session-token|\.htpasswd|known_hosts|authorized_keys|\.pgpass|\.my\.cnf|terraform\.tfvars|.*\.tfstate(?:\.backup)?)$/i,
  /^(?:service[-_]?account|client[-_]?secret).*\.json$/i,
  // recognizable credential / auth / token files, dotted or not (~/.claude/.credentials.json, .codex/auth.json, gh hosts)
  /credential/i, /^\.?(?:auth|oauth|tokens?|access[-_]?tokens?|refresh[-_]?tokens?|session|cookies?)(?:[-_.][a-z0-9]+)*\.(?:json|ya?ml|toml|txt|ini|db|sqlite)$/i,
  /^\.?(?:hosts\.yml|config\.json|\.?boto|\.s3cfg|\.gitcookies|\.pgpass|\.claude\.json)$/i,
]
const SENSITIVE_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.oasis-code', '.password-store', '.azure', 'keychains', '.config/gcloud', 'gcloud', '.vault-token', '.terraform.d',
  '.config/gh', '.codex', '.claude', '.gemini', '.config/github-copilot', '.netrc'])

/** Every path-like token of a string (a command's words, a path), unquoted. */
function pathTokens(text: string): string[] {
  return text.split(/[\s;&|<>()`"'=]+/).map((t) => t.trim()).filter((t) => t.length > 0)
}

/** True when the path names a credential, key or configuration source, or a file under one of `dataDirs`. */
export function sensitivePath(path: string, dataDirs: readonly string[] = []): boolean {
  const p = path.replace(/\\/g, '/').replace(/^\$\{?HOME\}?/, '~')
  // the data folder under every spelling of it (path_alias.ts: /private/tmp ↔ /tmp, …)
  if (withAliases(dataDirs).some((d) => d.length > 1 && (p === d || p.startsWith(`${d.replace(/[\\/]+$/, '')}/`)))) return true
  const parts = p.split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? ''
  if (SENSITIVE_BASENAME.some((re) => re.test(base))) return true
  const lower = parts.map((s) => s.toLowerCase())
  for (let i = 0; i < lower.length; i++) {
    if (SENSITIVE_SEGMENTS.has(lower[i]!)) return true
    if (i + 1 < lower.length && SENSITIVE_SEGMENTS.has(`${lower[i]}/${lower[i + 1]}`)) return true
  }
  return /^\/proc\/(?:self|\d+)\/environ$/.test(p)
}

/** One piece of an assignment's value, as the shell joins pieces into one word (`A=a'b'"c"d`, `A="x"y`, `A=a\ b`): a
 *  double-quoted segment (a backslash escapes the next character inside it), an ANSI-C quoted segment `$'…'` (bash,
 *  zsh: a backslash escapes inside it too, `$'x\'y'` is one segment), a single-quoted segment, a dollar not opening one
 *  (`$HOME`, `$"…"`'s dollar), a backslash and the character it escapes (a newline included: a continuation), or one
 *  plain character (never a quote, a backslash or a dollar). Quotes span lines, as in the shell; a quote never closed
 *  runs to the end of the command (the shell refuses such a command; read as one value). Not a shell: nothing is
 *  expanded or evaluated, only where the word ends is read.
 *  The pieces are lexically disjoint — each is decided by its first character (a dollar by the one after it) and, once
 *  started, can end in one place only (an open quote ends at the end of the input, never at a line's end) — so a value
 *  matches one way only and a failed match backtracks linearly: never the 2^n of overlapping alternatives repeated
 *  (`env A0='x' A1='x' … make`). */
const END = String.raw`(?![\s\S])`
const VALUE_PIECE = [
  String.raw`"(?:[^"\\]|\\[\s\S])*(?:"|\\?${END})`,
  String.raw`\$'(?:[^'\\]|\\[\s\S])*(?:'|\\?${END})`,
  String.raw`\$(?!')`,
  String.raw`'[^']*(?:'|${END})`,
  String.raw`\\(?:[\s\S]|${END})`,
  String.raw`[^\s;&|<>()` + '`' + String.raw`'"\\$]`,
].join('|')
/** One `NAME=value` word: its value any run of VALUE_PIECEs (empty included). */
const ASSIGNMENT = `[A-Za-z_][A-Za-z0-9_]*=(?:${VALUE_PIECE})*`
/** What may stand before a command without changing what it prints: variable assignments (`FOO=1 env`) and the words a
 *  shell runs it through (`sudo env`, `command env`, `exec set`). */
const RUN_PREFIX = `(?:(?:sudo|doas|command|builtin|exec|nohup|time)\\s+(?:-\\S+\\s+)*|${ASSIGNMENT}\\s+)*`
const SENSITIVE_COMMANDS: RegExp[] = [
  // an environment dump: bare env / printenv / set / export / export -p / declare -x|-p / compgen -v
  new RegExp(`(?:^|[;&|(\`]|\\$\\()\\s*${RUN_PREFIX}(?:set|export(?:\\s+-p)?|declare\\s+-[xp]|typeset\\s+-x|compgen\\s+-v)\\s*(?:$|[;&|>)\`])`, 'm'),
  // env as a dump (any path to it, only dump options, assignments and the `--` that ends options, no program after
  // them): `env`, `/usr/bin/env -0`, `env --null | sort`, `env FOO=1`, `env -i foo=bar`, `FOO=1 env`, `env --`,
  // `env -u TOKEN --` — `env FOO=1 bun run build` and `env -- bun run build` run a program: not one
  new RegExp(`(?:^|[;&|(\`]|\\$\\()\\s*${RUN_PREFIX}(?:\\S*\\/)?env(?:\\s+(?:-0|--null|-i|--ignore-environment|-u\\s+\\S+|--unset=\\S+|-v|--debug|--|${ASSIGNMENT}))*\\s*(?:$|[;&|>)\`])`, 'm'),
  /\bprintenv\b/,
  // any read of the environment from code, a property or a lookup included: its output is a value of the environment
  /\bprocess\.env\b|\b(?:process|Bun|Deno)\s*\[\s*['"`]env['"`]\s*\]|\bimport\.meta\.env\b|\bos\.environ\b|\bos\.getenv\b|\bgetenv\s*\(|\bDeno\.env\b|\bBun\.env\b|\bSystem\.getenv\b/,
  /\bENV\s*(?:\[|\.fetch|\.to_h|\.each)|\$env:|\bEnvironment\.GetEnvironmentVariables?\b|\bstd::env::var|\benv::vars?\b|\bos\.Getenv\b|\bos\.Environ\b/,
  /\/proc\/(?:self|\d+)\/environ/,
  // a keychain or a credential helper, a CLI asked for its token
  /\bsecurity\s+(?:find|dump)-(?:generic-|internet-)?(?:password|keychain)/,
  /\bgh\s+auth\s+(?:token|status\s+.*-t|status\s+.*--show-token)/,
  /\bgcloud\s+auth\s+(?:print-access-token|print-identity-token|application-default\s+print-access-token)/,
  /\baws\s+(?:configure\s+(?:get|export-credentials|list)|sts\s+get-session-token|ecr\s+get-login-password)/,
  /\baz\s+account\s+get-access-token/,
  /\bkubectl\s+config\s+view\b.*--raw/, /\bkubectl\s+get\s+secrets?\b.*-o/,
  /\bdocker-credential-/, /\bgit\s+credential\s+(?:fill|approve)/, /\bgit\s+config\b.*credential/,
  /\bop\s+(?:read|item\s+get)\b/, /\bvault\s+(?:read|kv\s+get|token\s+lookup)\b/, /\bheroku\s+auth:token\b/, /\bnpm\s+token\b/,
  // a secret variable printed
  /\b(?:echo|printf|print)\b[^|;&\n]*\$\{?[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSW|API_?KEY|PRIVATE|CREDENTIAL)/i,
  // any variable printed (`echo $HOME`, `printf '%s' "${my_token}"`, `print $f`): a variable of any name may hold an
  // exported value (`export foo=…` is as much the environment as HOME), so every named expansion is withheld —
  // a shell's own loop or local variable is withheld too (a false positive accepted, never a value let through)
  /\b(?:echo|printf|print)\b[^|;&\n]*\$\{?[A-Za-z_][A-Za-z0-9_]*/,
]

/** The script a shell is handed with -c (`sh -c 'env'`, `bash -lc "printenv | sort"`), read as a command of its own. */
const SHELL_C = /(?:^|[\s;&|(`])(?:\S*\/)?(?:ba|z|k|da|fi|tc|c)?sh\s+(?:-[A-Za-z]+\s+)*-[A-Za-z]*c[A-Za-z]*\s+(['"])([\s\S]*?)\1/g

function sensitiveCommand(command: string, dataDirs: readonly string[], depth = 0): boolean {
  if (SENSITIVE_COMMANDS.some((re) => re.test(command))) return true
  if (pathTokens(command).some((t) => sensitivePath(t, dataDirs))) return true
  // quotes and backslashes inside a word join its pieces (`cat .e"nv"`, `cat '.en'v`, `cat .en\\v`): the words read
  // again without them (a finite normalization, not a shell: no expansion is evaluated)
  if (/["'\\]/.test(command) && pathTokens(command.replace(/["'\\]/g, '')).some((t) => sensitivePath(t, dataDirs))) return true
  if (depth < 2) for (const m of command.matchAll(SHELL_C)) if (sensitiveCommand(m[2]!, dataDirs, depth + 1)) return true
  return false
}

/** True when the call's content (its arguments' preview, its result) must be withheld. */
export function sensitiveTool(tool: string, target: ToolTarget, dataDirs: readonly string[] = []): boolean {
  const path = target.path ?? ''
  if (path && sensitivePath(path, dataDirs)) return true
  const command = target.command ?? ''
  if (command && sensitiveCommand(command, dataDirs)) return true
  if (target.cwd && sensitivePath(target.cwd, dataDirs)) return true
  const url = target.url ?? ''
  if (url && /^file:/i.test(url)) {
    try { if (sensitivePath(decodeURIComponent(new URL(url).pathname), dataDirs)) return true } catch { return true }
  }
  return tool === 'bash' && /\b(?:cat|less|more|head|tail|bat|xxd|od|strings|base64)\b[^|;&\n]*\b(?:token|secret|credential|password)s?\b/i.test(command)
}
