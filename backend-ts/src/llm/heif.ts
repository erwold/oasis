/** A photo in the HEIF container (HEIC: what an iPhone takes, sometimes handed on under a .JPG name) made a JPEG, so
 *  it can be attached like any other image: no provider takes HEIC, and no browser draws it. The format is read from
 *  the bytes (the `ftyp` box and its brand); the conversion is the system's own (`sips`, macOS) — elsewhere the file
 *  is refused in words that say what to do. Only what the person attaches goes through here. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageRefused, MAX_IMAGE_BYTES, measureImage } from './images.ts'

/** The largest file taken for conversion (a photo at full size; the JPEG made of it must fit the image limit). */
export const MAX_HEIF_BYTES = 30 * 1024 * 1024
const BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1', 'heif'])
const SIPS = '/usr/bin/sips'
const CONVERT_TIMEOUT_MS = 30_000
// a first try at the photo's own size; when the JPEG is over the image limit, smaller and lighter
const TRIES: { side: number | null; quality: number }[] = [{ side: null, quality: 85 }, { side: 4096, quality: 80 }, { side: 2560, quality: 75 }]

/** Whether the bytes are a HEIF file: an `ftyp` box first, its brand one of HEIC's. */
export function isHeif(head: Uint8Array): boolean {
  if (head.length < 12) return false
  const word = (i: number) => String.fromCharCode(head[i]!, head[i + 1]!, head[i + 2]!, head[i + 3]!)
  return word(4) === 'ftyp' && BRANDS.has(word(8))
}

/** One conversion: the file at `from` written as a JPEG at `to` (null: it did not work). */
export type HeifConverter = (from: string, to: string, opts: { side: number | null; quality: number }) => Promise<boolean>

const sips: HeifConverter = async (from, to, { side, quality }) => {
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), ...(side !== null ? ['-Z', String(side)] : []), from, '--out', to]
  const child = Bun.spawn([SIPS, ...args], { stdout: 'ignore', stderr: 'ignore' })
  const timer = setTimeout(() => child.kill(), CONVERT_TIMEOUT_MS)
  try { return (await child.exited) === 0 } finally { clearTimeout(timer) }
}

/** The HEIF photo as a JPEG the harness accepts (measured as every image is). Refused: bytes that are no HEIF, a
 *  file over the size taken, a system without the converter, a file the converter could not read. */
export async function heifToJpeg(bytes: Uint8Array, { platform = process.platform, convert = sips }: { platform?: string; convert?: HeifConverter } = {}): Promise<Uint8Array> {
  if (!isHeif(bytes)) throw new ImageRefused('not a HEIC image (the format is read from the file itself)')
  if (bytes.length > MAX_HEIF_BYTES) throw new ImageRefused(`the HEIC image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; one up to ${MAX_HEIF_BYTES / 1024 / 1024} MB is converted`)
  if (platform !== 'darwin') throw new ImageRefused('a HEIC image is converted to JPEG on macOS only; export it as JPEG or PNG and attach that')
  const dir = mkdtempSync(join(tmpdir(), 'oasis-code-heif-'))
  try {
    const from = join(dir, 'in.heic')
    const to = join(dir, 'out.jpg')
    writeFileSync(from, bytes, { mode: 0o600 })
    for (const attempt of TRIES) {
      rmSync(to, { force: true })
      if (!(await convert(from, to, attempt))) throw new ImageRefused('the HEIC image could not be converted to JPEG (a damaged file, or a kind the system does not read)')
      const out = new Uint8Array(readFileSync(to))
      if (out.length > MAX_IMAGE_BYTES) continue
      measureImage(out)
      return out
    }
    throw new ImageRefused(`the HEIC image is still over ${MAX_IMAGE_BYTES / 1024 / 1024} MB as a JPEG; make it smaller and attach that`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
