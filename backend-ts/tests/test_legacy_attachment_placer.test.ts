/** The legacy placement (history before ref-v1 says `saved at <temp>/attachments/<sha12>-<name>`): the same path,
 *  word for word; the harness itself never writes into the folder a command writes — a confined writer does, once per
 *  file, through a fresh exclusive file renamed into place, so a link planted at the folder or the name leads nowhere
 *  outside — and anything less than full enforcement, a wrong byte or an oversized file writes nothing at all. */

import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { SeatbeltRuntime, type Enforcement, type IsolationRuntime, type IsolationReport, type Sandbox } from '../src/execution/isolation.ts'
import { LEGACY_PLACEMENT_MAX_BYTES, LegacyAttachmentPlacer, legacyPlacementPath, legacyPlacementSandbox } from '../src/workspace/legacy_attachment_placer.ts'

const roots: string[] = []
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

function setup() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'oasis-legacy-place-')))
  roots.push(base)
  const data = join(base, 'data')
  const temp = join(data, 'sandboxes', 'ws_1', 'tmp')
  const scratch = join(data, 'scratch')
  const victim = join(base, 'victim')
  for (const d of [temp, scratch, victim]) mkdirSync(d, { recursive: true })
  writeFileSync(join(victim, 'important.db'), 'ORIGINAL')
  const dir = join(temp, 'attachments')
  const bytes = Buffer.from('%PDF-1.4 legacy attachment bytes')
  const file = { name: 'Quarterly report (final).pdf', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, media_type: 'application/pdf' }
  return { base, data, temp, scratch, victim, dir, bytes, file }
}

/** The writer run as it is, without a kernel: what the writer itself refuses and how it writes (the kernel's own
 *  guarantee is the macOS test below). The box is still rendered, so a box the real runtime would refuse is refused. */
function unconfined(dataDir: string): IsolationRuntime {
  return {
    name: 'test-unconfined', fingerprint: () => 'test',
    command: (argv: string[], box: Sandbox) => { new SeatbeltRuntime({ extra_read_deny: [dataDir] }).profile(box); return argv },
    probe: async () => ({}) as IsolationReport,
  }
}

function placerOf(s: ReturnType<typeof setup>, enforcement: Enforcement = 'full', runtime: IsolationRuntime = unconfined(s.data)) {
  const refused: string[] = []
  const placer = new LegacyAttachmentPlacer({ runtime, enforcement: () => enforcement, data_dir: s.data, scratch_dir: s.scratch, on_refused: (_f, _p, why) => refused.push(why) })
  return { placer, refused }
}

/** The name formula of the baseline's folderPlacer (main@7b83d48 llm/attachments.ts), kept here as the reference: the
 *  unconfined placer itself is gone from the product (nothing may write into a folder a command writes). */
const baselinePath = (dir: string, file: { name: string; sha256: string }) =>
  join(dir, `${file.sha256.slice(0, 12)}-${basename(file.name).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '') || 'attachment'}`)

test('the path is the one the legacy note names, character for character', () => {
  const s = setup()
  const dir = join(s.base, 'legacy-dir')
  for (const name of ['Quarterly report (final).pdf', '..hidden.mp4', '../../etc/passwd', 'clip.MOV', '会议录像.webm', '', '...', 'a/b\\c.pdf']) {
    const file = { ...s.file, name }
    expect(legacyPlacementPath(dir, file)).toBe(baselinePath(dir, file))
  }
  expect(legacyPlacementPath(dir, s.file)).toBe(join(dir, `${s.file.sha256.slice(0, 12)}-Quarterly_report_final_.pdf`))
  expect(existsSync(dir)).toBe(false)
})

test('placed once: the bytes are read once, written by the confined writer, exactly; later requests read nothing', () => {
  const s = setup()
  const { placer, refused } = placerOf(s)
  let loads = 0
  const load = () => { loads += 1; return s.bytes }
  const paths = Array.from({ length: 5 }, () => placer.place(s.dir, s.file, load))
  expect(new Set(paths)).toEqual(new Set([legacyPlacementPath(s.dir, s.file)]))
  expect(loads).toBe(1)
  expect(refused).toEqual([])
  expect(readFileSync(paths[0]!)).toEqual(s.bytes)
  expect(lstatSync(paths[0]!).isFile()).toBe(true)
  // no temporary file left beside it, nothing in the harness's scratch
  expect(readdirSync(s.dir)).toEqual([paths[0]!.split('/').pop()!])
  expect(readdirSync(s.scratch)).toEqual([])
  expect(placer.outcome(s.dir, s.file)?.status).toBe('placed')
  // forgotten (a new run): placed again, once more
  placer.forget(s.dir)
  placer.place(s.dir, s.file, load)
  expect(loads).toBe(2)
})

test('fail closed: without full enforcement, over the legacy bound, or with bytes that are not the attachment, nothing is written or read', () => {
  for (const enforcement of ['partial', 'unavailable'] as const) {
    const s = setup()
    const { placer, refused } = placerOf(s, enforcement)
    let loads = 0
    const path = placer.place(s.dir, s.file, () => { loads += 1; return s.bytes })
    expect(path).toBe(legacyPlacementPath(s.dir, s.file))
    expect(loads).toBe(0)
    expect(existsSync(s.dir)).toBe(false)
    expect(refused[0]).toContain('not fully enforced')
    placer.place(s.dir, s.file, () => { loads += 1; return s.bytes })
    expect(loads).toBe(0)
    expect(refused.length).toBe(1)
  }
  const s = setup()
  const { placer, refused } = placerOf(s)
  let loads = 0
  placer.place(s.dir, { ...s.file, name: 'big.mp4', bytes: LEGACY_PLACEMENT_MAX_BYTES + 1 }, () => { loads += 1; return s.bytes })
  expect(loads).toBe(0)
  placer.place(s.dir, { ...s.file, name: 'other.pdf' }, () => Buffer.from('not the attachment bytes, same length!!!').subarray(0, s.bytes.length))
  placer.place(s.dir, { ...s.file, name: 'nosha.pdf', sha256: 'x' }, () => s.bytes)
  expect(refused.map((r) => r.split(' ').slice(0, 4).join(' '))).toEqual(['a legacy placement holds', 'the bytes are not', 'the file has no'])
  expect(existsSync(s.dir)).toBe(false)
})

test('a link or a hard link planted at the name is replaced, never written through; a linked or file `attachments` is refused', () => {
  // a link at the final name, pointing at a file outside: replaced by the placed file; the target untouched
  {
    const s = setup()
    mkdirSync(s.dir)
    const target = legacyPlacementPath(s.dir, s.file)
    symlinkSync(join(s.victim, 'important.db'), target)
    const { placer, refused } = placerOf(s)
    placer.place(s.dir, s.file, s.bytes)
    expect(refused).toEqual([])
    expect(lstatSync(target).isSymbolicLink()).toBe(false)
    expect(readFileSync(target)).toEqual(s.bytes)
    expect(readFileSync(join(s.victim, 'important.db'), 'utf8')).toBe('ORIGINAL')
  }
  // a hard link at the final name to a file outside: the name is replaced, the other file keeps its bytes
  {
    const s = setup()
    mkdirSync(s.dir)
    const target = legacyPlacementPath(s.dir, s.file)
    linkSync(join(s.victim, 'important.db'), target)
    const { placer } = placerOf(s)
    placer.place(s.dir, s.file, s.bytes)
    expect(readFileSync(target)).toEqual(s.bytes)
    expect(readFileSync(join(s.victim, 'important.db'), 'utf8')).toBe('ORIGINAL')
    expect(lstatSync(join(s.victim, 'important.db')).nlink).toBe(1)
  }
  // `attachments` a link to a folder outside, a file, or a folder at the name: refused; nothing lands outside
  for (const plant of ['folder link', 'a file', 'a folder at the name'] as const) {
    const s = setup()
    if (plant === 'folder link') symlinkSync(s.victim, s.dir)
    else if (plant === 'a file') writeFileSync(s.dir, 'not a folder')
    else mkdirSync(legacyPlacementPath(s.dir, s.file), { recursive: true })
    const { placer, refused } = placerOf(s)
    placer.place(s.dir, s.file, s.bytes)
    expect(refused.length).toBe(1)
    expect(readdirSync(s.victim)).toEqual(['important.db'])
    expect(readFileSync(join(s.victim, 'important.db'), 'utf8')).toBe('ORIGINAL')
  }
})

test('the writer\'s box: the real temporary folder writable and pinned, the data directory denied whole (the writer comes inline), no network, no hard link', () => {
  const s = setup()
  const box = legacyPlacementSandbox(s.temp, s.data)
  expect(box).toEqual({ writable: [s.temp], write_deny: [], read_deny: [s.data], read_allow: [s.temp], pinned: [s.temp], network: false, deny_hardlinks: true })
  const profile = new SeatbeltRuntime({ extra_read_deny: [s.data] }).profile(box)
  expect(profile).toContain('(deny network*)')
  expect(profile).toContain('\n(deny file-link)\n')
  expect(profile).not.toContain('exact input files')
  expect(profile).not.toContain(`(subpath "${s.scratch}")`)
})

test('a refusal is always reported to the caller (a visible event), and the outcome says refused — never a silent `saved`', () => {
  const s = setup()
  const seen: { path: string; reason: string }[] = []
  const placer = new LegacyAttachmentPlacer({ runtime: unconfined(s.data), enforcement: () => 'partial', data_dir: s.data, scratch_dir: s.scratch, on_refused: (_f, path, reason) => seen.push({ path, reason }) })
  const path = placer.place(s.dir, s.file, s.bytes)
  expect(seen).toEqual([{ path, reason: expect.stringContaining('not fully enforced') }])
  expect(placer.outcome(s.dir, s.file)).toEqual({ status: 'refused', path, reason: seen[0]!.reason })
  expect(existsSync(path)).toBe(false)
  // a scratch folder outside the data directory is not the harness's own: refused, nothing run
  const outside = new LegacyAttachmentPlacer({ runtime: unconfined(s.data), enforcement: () => 'full', data_dir: s.data, scratch_dir: join(s.base, 'elsewhere'), on_refused: (_f, p, reason) => seen.push({ path: p, reason }) })
  outside.place(s.dir, s.file, s.bytes)
  expect(seen[1]!.reason).toContain('scratch folder is not inside its data directory')
  expect(existsSync(path)).toBe(false)
})

// ---- the real kernel ------------------------------------------------------------------------------------------

test.skipIf(process.platform !== 'darwin')('macOS, the real Seatbelt: the confined writer places the file; under its box a write through a link that leads out of the temporary folder, and a hard link, are refused', () => {
  const s = setup()
  const runtime = new SeatbeltRuntime({ extra_read_deny: [s.data] })
  const { placer, refused } = placerOf(s, 'full', runtime)
  placer.place(s.dir, s.file, s.bytes)
  expect(refused).toEqual([])
  expect(readFileSync(legacyPlacementPath(s.dir, s.file))).toEqual(s.bytes)
  // the kernel's own guarantee, which the writer's checks only precede: a folder link swapped in after any check
  // still leads nowhere outside, and no hard link is made
  symlinkSync(s.victim, join(s.temp, 'out'))
  // and the data directory, the writer's own scratch folder included, is not read
  writeFileSync(join(s.scratch, 'secret'), 'S')
  const probe = `const fs = require('node:fs'); const { T, V, D } = process.env; const out = {}
for (const [k, f] of Object.entries({ through_link: () => fs.writeFileSync(T + '/out/planted', 'X'), link: () => fs.linkSync(V, T + '/alias'), data: () => fs.readFileSync(D + '/scratch/secret'), inside: () => fs.writeFileSync(T + '/inside', 'ok') })) { try { f(); out[k] = 'ok' } catch (e) { out[k] = e.code } }
console.log(JSON.stringify(out))`
  const argv = runtime.command([process.execPath, '-e', probe], legacyPlacementSandbox(s.temp, s.data), join(s.scratch, 'probe.sb'))
  const result = spawnSync(argv[0]!, argv.slice(1), { cwd: s.temp, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin', HOME: s.temp, BUN_BE_BUN: '1', T: s.temp, V: join(s.victim, 'important.db'), D: s.data } })
  expect({ exit: result.status, out: result.stdout.trim(), err: result.stderr.trim().slice(0, 200) }).toEqual({ exit: 0, out: JSON.stringify({ through_link: 'EPERM', link: 'EPERM', data: 'EPERM', inside: 'ok' }), err: '' })
  expect(existsSync(join(s.victim, 'planted'))).toBe(false)
  expect(lstatSync(join(s.victim, 'important.db')).nlink).toBe(1)
}, 60_000)
