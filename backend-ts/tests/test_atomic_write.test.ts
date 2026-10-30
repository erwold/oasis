/** A write replaces what the writer saw, and only that: a file that must be new is never put over one created
 *  meanwhile (the link fails), a file that changed since it was read is left as it is, and on any failure the target
 *  keeps its bytes and no temporary file remains. (The short-write and the ENOSPC injections, and the real second
 *  process between the check and the write, are Codex's qa_v2_atomic_faults and qa_v2_file_integrity.) */

import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite, sha256Hex, WriteConflict } from '../src/store.ts'
import { tempDir } from './helpers.ts'

test('a new file is written only where nothing is; a replacement only over the version it expects', () => {
  const dir = tempDir('oasis-atomic-')
  const target = join(dir, 'f.txt')
  atomicWrite(target, 'FIRST', { expect: { absent: true } })
  expect(readFileSync(target, 'utf8')).toBe('FIRST')
  // someone else's file is there now: a "new file" write is refused and theirs stays
  expect(() => atomicWrite(target, 'MINE', { expect: { absent: true } })).toThrow(WriteConflict)
  expect(readFileSync(target, 'utf8')).toBe('FIRST')
  // replaced over the version seen; refused once it changed
  atomicWrite(target, 'SECOND', { expect: { sha256: sha256Hex('FIRST') } })
  expect(readFileSync(target, 'utf8')).toBe('SECOND')
  writeFileSync(target, 'OTHER PROCESS')
  expect(() => atomicWrite(target, 'THIRD', { expect: { sha256: sha256Hex('SECOND') } })).toThrow(WriteConflict)
  expect(readFileSync(target, 'utf8')).toBe('OTHER PROCESS')
  expect(readdirSync(dir).filter((f) => f.startsWith('.tmp-'))).toEqual([])
  // no expectation: the plain replacement, every byte of it
  const big = Buffer.alloc(3 * 1024 * 1024, 7)
  atomicWrite(target, big)
  expect(readFileSync(target).equals(big)).toBe(true)
})
