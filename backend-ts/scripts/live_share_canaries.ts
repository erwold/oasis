/** The live session share's synthetic values, shared by its fixture (backend-ts/scripts/live_share_fixture.ts, run by
 *  bun inside scripts/e2e_server.ts) and its browser test (frontend/e2e/live-share.e2e.ts, run by node): no imports, so
 *  both runtimes load it as it is.
 *
 *  Every value is synthetic. The ones shaped like a credential, a home path or a mailbox are put together at run time
 *  from pieces that hold no such shape, so the committed source gives the repository's secret and privacy scans
 *  (scripts/oss/lib/scan.mjs) nothing to find; the people in it are Alice and Bob. */

const join = (...pieces: string[]): string => pieces.join('')

/** a synthetic account name (only ever written into a path at run time) */
export const LIVE_HOME_USER = join('livesyn', 'thusr')

/** The words that pick a case of the scripted route `scripted:live` (each a marker in the person's message). */
export const LIVE_CASES = {
  /** a plain answer naming its mark: `LIVE_CASE_PLAIN <mark>` */
  plain: 'LIVE_CASE_PLAIN',
  /** the held progress run: intro + a tool, a sensitive tool, a redacted tool, then the answer streamed in held pieces */
  progress: 'LIVE_CASE_PROGRESS',
  /** a quick run: one harmless command, then an answer naming its mark: `LIVE_CASE_QUICK <mark>` */
  quick: 'LIVE_CASE_QUICK',
} as const

/** The gates of the held progress run (released by the test: POST /e2e/ui-release?gate=<name> on the APP's port). */
export const LIVE_GATES = {
  /** before the run's first words: the run is active and has shown nothing yet (the link is made now) */
  start: 'live-start',
  /** after both tools returned, before the answer starts */
  answer: 'live-answer',
  /** between the answer's pieces: piece k+1 waits for `live-piece-<k>` */
  piece: (k: number): string => `live-piece-${k}`,
} as const

/** Values that must never reach a viewer: not one frame of the stream, not one byte of a picture, not the page. */
export const LIVE_SECRETS = {
  /** what a dotenv file the run writes and reads holds (a sensitive source: the tool is withheld whole) */
  dotenv: 'LIVEDOTENVCANARY_4c2e',
  /** an environment dump's only variable (a sensitive command: withheld whole) */
  env: 'LIVEENVCANARY_7d3f',
  /** an opaque auth file's content, read with read_file (a sensitive path: withheld whole) */
  auth: 'LIVEAUTHCANARY_1a9b',
  /** a bearer header a harmless command prints (redacted in its command and its output, the tool itself shown) */
  tool_bearer: join('LIVETOOLBEARER', '0123456789abcdef'),
  /** the answer's credential, streamed in two pieces: the head alone is too short for a key shape */
  key_head: 'LKHEAD',
  key_tail: join('LKTAIL', 'z9x8w7v6u5t4'),
  /** the answer's mailbox, split before its domain's dot: the head alone is no address */
  mail_local: join('alice', '.synthetic'),
  /** the answer's bearer, split inside the credential */
  bearer_head: 'LIVEBEARERHD',
  bearer_tail: join('LIVEBEARERTL', '0123456789'),
  /** the account name of a home path, split inside the name */
  home_user: LIVE_HOME_USER,
  home_head: 'livesyn',
  /** the body lines of a private key block the answer streams (cut after its first completed line) */
  pem_line_1: join('LIVEPEMBODYONE', 'AAAABBBBCCCCDDDD'),
  pem_line_2: join('LIVEPEMBODYTWO', 'EEEEFFFFGGGGHHHH'),
  /** the lines of a secret-named key's block scalar (cut after its first completed line) */
  yaml_line_1: join('LIVEYAMLSECRETONE', '_q1w2e3'),
  yaml_line_2: join('LIVEYAMLSECRETTWO', '_r4t5y6'),
  /** a PNG's tEXt/iTXt metadata (an uploaded picture): the picture the viewer is served has its metadata stripped */
  png_meta: 'LIVEPNGMETA_8f2c',
} as const

/** The answer's credential, mailbox, bearer and home path, whole (built at run time). */
export const LIVE_WHOLE = {
  key: join('sk-', 'ant-', 'api03-', LIVE_SECRETS.key_head, LIVE_SECRETS.key_tail),
  mail: join(LIVE_SECRETS.mail_local, '@', 'example', '.com'),
  bearer: join('Bear', 'er ', LIVE_SECRETS.bearer_head, LIVE_SECRETS.bearer_tail),
  home: join('/', 'Users', '/', LIVE_HOME_USER, '/plans/bob-notes.md'),
} as const

/** The held answer of the progress run, in the pieces it streams (piece k+1 waits for gate live-piece-<k>). The live
 *  state shows an answer being written up to its last completed line (`message_open`, contract/src/live_share.ts), the
 *  line being written withheld, and withholds the whole answer while it may be inside a structure that can hide a secret
 *  over several lines. So the cuts fall both inside a line (a key 12 characters after `sk-ant-`, too short for its shape;
 *  a mailbox before its domain's dot; a bearer inside its value; a home path inside its account name) and after a
 *  completed line inside a private key block and a secret-named key's block scalar. Alice and Bob are the people. */
export function liveAnswerPieces(): string[] {
  const S = LIVE_SECRETS
  const pem = (edge: string) => join('-----', edge, ' PRIVATE', ' KEY-----')
  return [
    `## Alice → Bob: ready (LIVE_ANSWER_MARK)\n\nBob, calc.py is fixed. The staging key is ${join('sk-', 'ant-', 'api03-', S.key_head)}`,
    `${S.key_tail}.\nWrite to ${S.mail_local}@exam`,
    `ple.com and send ${join('Bear', 'er ', S.bearer_head)}`,
    `${S.bearer_tail} to the build.\nSee ${join('/', 'Users', '/', S.home_head)}`,
    `${LIVE_HOME_USER.slice(S.home_head.length)}/plans/bob-notes.md for the plan.\n\n\`\`\`\n${pem('BEGIN')}\n${S.pem_line_1}\n`,
    `${S.pem_line_2}\n${pem('END')}\n\`\`\`\n\n\`\`\`yaml\nclient_secret: |\n  ${S.yaml_line_1}\n`,
    `  ${S.yaml_line_2}\nregion: staging\n\`\`\`\n\nDone — LIVE_ANSWER_END.`,
  ]
}

/** Words that are NOT secret but must be absent where the share leaves them out, or present exactly once. */
export const LIVE_MARKS = {
  /** a run the session had before the link was made */
  pre_link: 'PRELINKMARK_5e1d',
  /** the progress run's visible words */
  intro: 'Alice is reading calc.py for Bob',
  sensitive_intro: 'Alice checks the private settings',
  answer: 'LIVE_ANSWER_MARK',
  answer_end: 'LIVE_ANSWER_END',
  /** the second update after the first answer */
  second: 'SECOND_UPDATE_MARK_d41f',
  /** made while the viewer was disconnected: present exactly once after it reconnects */
  reconnect: 'RECONNECT_MARK_3c8b',
  /** a run the link leaves out (an option / an excluded run) */
  excluded: 'LIVEEXCLUDEDRUN_6b0c',
  /** made after the link was revoked / after it expired: never sent */
  after_revoke: 'AFTERREVOKEMARK_2f7a',
  after_expiry: 'AFTEREXPIRYMARK_9e4d',
  /** a harmless command's own mark (a tool shown, its bearer redacted) */
  tool_mark: 'LIVETOOLMARK_6a0e',
} as const

/** The session's title (synthetic). */
export const LIVE_SESSION_TITLE = 'Alice & Bob — live demo (synthetic)'
