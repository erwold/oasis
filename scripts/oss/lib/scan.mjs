// Text scanning shared by scan-secrets.mjs (snapshot / history) and export-public.mjs. Two kinds of finding:
//   secret   a likely credential or private key — fails a scan and an export
//   privacy  a personal path, a personal e-mail address, a private host name or an owner-supplied private marker —
//            listed for review; fails an export unless reviewed (see public-export.json "allow")
// A finding never carries the matched text: only the rule, the place and a redacted shape (the first characters that
// identify the kind of value, and its length). Nothing here reads files, runs commands or touches the network.

/** Rules for secrets, applied per line. Kept to shapes with a low false-positive rate; a generic "password = ..."
 *  rule is deliberately absent (tests are full of fake ones), so this is a tripwire, not a guarantee. */
export const SECRET_RULES = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'anthropic-key', re: /\bsk-ant-(?:api|admin|oat|ort)\d{2}-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'google-oauth-secret', re: /\bGOCSPX-[A-Za-z0-9_-]{20,}/ },
  { id: 'google-refresh-token', re: /\b1\/\/0[A-Za-z0-9_-]{40,}/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{60,}/ },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{34,}\b/ },
  { id: 'tailscale-key', re: /\btskey-(?:auth|api|client)-[A-Za-z0-9-]{16,}/ },
  { id: 'runpod-key', re: /\brpa_[A-Za-z0-9]{30,}\b/ },
  { id: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/ },
  // user:password@host, except on the reserved example / test / invalid names (RFC 2606, RFC 6761) and localhost
  { id: 'url-credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"`]{1,64}:[^\s@/'"`]{8,}@(?!(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|[A-Za-z0-9-]+\.(?:invalid|test|example|localhost)|localhost)(?![A-Za-z0-9.-]))[A-Za-z0-9.-]+/i },
]

/** Placeholder user names that may follow /Users/ or /home/ without being anyone's real home. */
const PLACEHOLDER_USERS = 'runner|user|users|me|you|alice|bob|carol|dave|eve|example|name|person|someone|somebody|fixture|test|tester|dev|demo|jane|john|foo|bar|[A-Za-z]|USER|USERNAME|YOU|NAME|ME'

/** Rules for privacy markers. */
export const PRIVACY_RULES = [
  { id: 'home-path', re: new RegExp(`/(?:Users|home)/(?!(?:${PLACEHOLDER_USERS})(?![A-Za-z0-9._-])|<|\\$|\\{|\\*|\\.|…)[A-Za-z0-9._-]+`) },
  { id: 'windows-home-path', re: /[A-Za-z]:\\\\?Users\\\\?(?!Public\b|<|%)[A-Za-z0-9._-]+/ },
  { id: 'personal-email', re: /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|qq|163|126|outlook|hotmail|live|icloud|me|yahoo|proton|protonmail|foxmail)\.(?:com|me|cn)\b/i },
  // a MagicDNS name, except the placeholder tailnets docs and tests use (tailnet, tail1234, tailXXXX, example)
  { id: 'tailnet-host', re: /\b[a-z0-9-]+\.(?!(?:tailnet|tail0+|tail1234|tailx+|example|your-?tailnet)\.ts\.net\b)[a-z0-9-]+\.ts\.net\b/i },
]

/** A redacted shape of a match: its first 4 characters and its length (enough to tell the kind, never the value). */
export function redact(text) {
  return `${text.slice(0, 4)}…(${text.length} chars)`
}

/** Owner-supplied private markers (a local file outside the repository, one literal per line, # comments): the
 *  owner's user name, real names, private host names. Matched case-insensitively; reported by index only, so the
 *  report never repeats the marker. Markers shorter than 3 characters are refused (they would match everything). */
export function parseMarkers(text) {
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.length < 3) throw new Error('a private marker must be at least 3 characters long')
    out.push(line.toLowerCase())
  }
  return out
}

/** Whether an allow entry covers a finding: same rule, the exact path, and — always — the exact content hash of the
 *  file, so a changed file is reported again. Folder-wide or hash-less entries are not accepted. */
export function allowEntryCovers(entry, { rule, path, sha256 }) {
  return entry.rule === rule && entry.path === path && typeof entry.sha256 === 'string' && entry.sha256 === sha256
}

/** Validate an allow list (throws on an entry that is too broad). */
export function checkAllowList(allow) {
  for (const a of allow ?? []) {
    if (!a || typeof a.path !== 'string' || typeof a.rule !== 'string' || typeof a.why !== 'string') throw new Error('every allow entry needs path, rule, sha256 and why')
    if (a.path.endsWith('/') || a.path.includes('*')) throw new Error(`allow entry ${a.path}: a folder or pattern is too broad; name one file`)
    if (!/^[0-9a-f]{64}$/.test(a.sha256 ?? '')) throw new Error(`allow entry ${a.path}: needs the sha256 of the exact reviewed content`)
  }
  return allow ?? []
}

/** Findings in one text (pure). `allow`: reviewed exact-file entries (path + rule + sha256 of the content); a covered
 *  finding stays in the list with `allowed: true` and its reason, so the report still shows it. */
export function scanText(path, text, { allow = [], sha256 = null, markers = [] } = {}) {
  const findings = []
  const lines = text.split(/\r?\n/)
  const allowedBy = (rule) => allow.find((a) => allowEntryCovers(a, { rule, path, sha256 }))
  lines.forEach((line, i) => {
    for (const [kind, rules] of [['secret', SECRET_RULES], ['privacy', PRIVACY_RULES]]) {
      for (const { id, re } of rules) {
        const m = re.exec(line)
        if (!m) continue
        const a = allowedBy(id)
        findings.push({ kind, rule: id, path, line: i + 1, shape: redact(m[0]), ...(a ? { allowed: true, why: a.why } : {}) })
      }
    }
    if (markers.length) {
      const lower = line.toLowerCase()
      markers.forEach((mk, n) => {
        if (lower.includes(mk)) findings.push({ kind: 'privacy', rule: 'private-marker', path, line: i + 1, shape: `marker #${n + 1}` })
      })
    }
  })
  return findings
}

/** Whether bytes look like text worth scanning (no NUL in the first 8 KB). */
export function looksText(buf) {
  return !buf.subarray(0, 8192).includes(0)
}
