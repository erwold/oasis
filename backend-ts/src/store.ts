/** Content-addressed asset store (logs, patches, reports) under the data directory:
 *  <assets_dir>/<project_id>/<kind>/<sha256[:16]>.<ext>. Writes are atomic and idempotent; nothing overwrites an
 *  existing file. */

import { createHash, randomBytes } from 'node:crypto'
import { closeSync, createReadStream, existsSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { Asset } from '@oasis-code/contract'
import type { Conn } from './db/database.ts'
import * as repo from './db/repo.ts'

export const KINDS = ['log', 'patch', 'report', 'manifest', 'text', 'data', 'image'] as const

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The target changed under a write that expected it as it was: nothing was replaced. */
export class WriteConflict extends Error {
  constructor(message: string) { super(message); this.name = 'WriteConflict' }
}

export interface AtomicWriteOptions {
  /** the permission bits the file ends with, exactly (set on the temporary file before it takes the name, so the
   *  umask does not cut them); takes precedence over keep_mode */
  mode?: number
  /** replacing an existing regular file: the new file keeps its read / write / execute bits (mode & 0o777 — never
   *  setuid, setgid or sticky; owner, ACLs and extended attributes are not carried). A new file gets the default. */
  keep_mode?: boolean
  /** what the target must be when the new bytes take its place: absent (a new file — never one that appeared
   *  meanwhile), or the version the writer saw (the sha256 of its bytes) */
  expect?: { absent: true } | { sha256: string } | null
}

/** Write `data` to `path` through a temporary file in the same directory: every byte written (a short write goes
 *  on from where it stopped; a write that makes no progress fails), then one rename — or, for a file that must be
 *  new, one link, which fails when the name was taken meanwhile. With `expect`, the target is checked again right
 *  before it is replaced and a changed one is left as it is (WriteConflict). On any failure the target is untouched
 *  and the temporary file removed. */
export function atomicWrite(path: string, data: Uint8Array | string, opts: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.tmp-${randomBytes(6).toString('hex')}`)
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  // the bits the replaced file had, read before the new bytes are written (a regular file only)
  let kept: number | null = null
  if (opts.mode === undefined && opts.keep_mode) {
    try { const st = lstatSync(path); if (st.isFile()) kept = st.mode & 0o777 } catch { kept = null }
  }
  const fd = openSync(tmp, 'w', 0o644)
  let open = true
  try {
    const final = opts.mode !== undefined ? opts.mode & 0o7777 : kept
    if (final !== null) fchmodSync(fd, final)
    for (let done = 0; done < bytes.byteLength;) {
      const n = writeSync(fd, done === 0 ? bytes : bytes.subarray(done))
      if (!(n > 0)) throw Object.assign(new Error(`short write: ${done} of ${bytes.byteLength} bytes, no progress`), { code: 'EIO' })
      done += n
    }
    closeSync(fd)
    open = false
    const expect = opts.expect ?? null
    if (expect !== null && 'absent' in expect) {
      try { linkSync(tmp, path) } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new WriteConflict(`${path} was created by someone else meanwhile`)
        throw e
      }
      unlinkSync(tmp)
      return
    }
    if (expect !== null) {
      let current: string | null
      try { current = sha256Hex(readFileSync(path)) } catch { current = null }
      if (current !== expect.sha256) throw new WriteConflict(`${path} changed meanwhile`)
    }
    renameSync(tmp, path)
  } catch (e) {
    if (open) { try { closeSync(fd) } catch { /* closed */ } }
    if (existsSync(tmp)) unlinkSync(tmp)
    throw e
  }
}

export class AssetStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  put(projectId: string, kind: string, data: Uint8Array, ext = 'txt'): [string, string] {
    if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`unknown asset kind '${kind}'`)
    const digest = sha256Hex(data)
    const path = join(this.root, projectId, kind, `${digest.slice(0, 16)}.${ext}`)
    if (!existsSync(path)) atomicWrite(path, data)
    return [relative(this.root, path), digest]
  }

  save(conn: Conn, projectId: string, kind: string, data: Uint8Array | string, opts: { ext?: string; meta?: Record<string, unknown> } = {}): Asset {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    const [rel, digest] = this.put(projectId, kind, bytes, opts.ext ?? 'txt')
    return repo.insertAsset(conn, projectId, kind, digest, bytes.length, rel, opts.meta ?? {})
  }

  read(relPath: string): Buffer {
    return readFileSync(this.inside(relPath))
  }

  /** An asset's real path, refused when it leads out of the store. */
  private inside(relPath: string): string {
    const root = realpathSync(this.root)
    const path = realpathSync(resolve(root, relPath.replace(/\\/g, '/')))
    if (!path.startsWith(root + sep)) throw new Error('asset path escapes its store')
    return path
  }

  /** A file saved as an asset without its bytes held in memory (a command's log of any size): hashed as a stream,
   *  then copied (a clone where the volume makes one) under a temporary name that takes the asset's only once whole. */
  async saveFile(conn: Conn, projectId: string, kind: string, file: string, opts: { ext?: string; meta?: Record<string, unknown> } = {}): Promise<Asset> {
    if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`unknown asset kind '${kind}'`)
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
      hash.update(chunk as Buffer)
      size += (chunk as Buffer).length
    }
    const digest = hash.digest('hex')
    const path = join(this.root, projectId, kind, `${digest.slice(0, 16)}.${opts.ext ?? 'txt'}`)
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
      try {
        await copyFile(file, tmp)
        renameSync(tmp, path)
      } catch (e) {
        try { unlinkSync(tmp) } catch { /* never made */ }
        throw e
      }
    }
    return repo.insertAsset(conn, projectId, kind, digest, size, relative(this.root, path), opts.meta ?? {})
  }

  /** At most `length` bytes of an asset from `offset`, and its whole size: a page, never the whole file in memory. */
  readRange(relPath: string, offset: number, length: number): { bytes: Buffer; total: number } {
    const fd = openSync(this.inside(relPath), 'r')
    try {
      const total = fstatSync(fd).size
      const start = Math.max(0, Math.min(offset, total))
      const want = Math.max(0, Math.min(length, total - start))
      const buffer = Buffer.alloc(want)
      let got = 0
      while (got < want) {
        const n = readSync(fd, buffer, got, want - got, start + got)
        if (n <= 0) break
        got += n
      }
      return { bytes: buffer.subarray(0, got), total }
    } finally {
      closeSync(fd)
    }
  }

  abspath(relPath: string): string {
    return join(this.root, relPath)
  }
}
