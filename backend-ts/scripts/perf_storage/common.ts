/** Shared helpers of the storage performance benchmarks (scripts/perf_storage/). Every path comes from the
 *  environment (run.sh sets them); nothing here names a machine, a user or a data directory. Output is aggregate:
 *  labels chosen by the script, numbers, SQL text of the code and SQLite's query plans — never a row's content, a
 *  bound parameter or a path from a database. */

import { cpus, platform, arch, totalmem, release } from 'node:os'
import { existsSync, mkdirSync, readdirSync, lstatSync, realpathSync, statfsSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { Database } from 'bun:sqlite'
import type { Conn, Param } from '../../src/db/database.ts'

export interface Stats { n: number; min: number; p50: number; p95: number; max: number; mean: number }

export function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b)
  const q = (p: number) => s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]! : NaN
  const round = (v: number) => Math.round(v * 1000) / 1000
  return { n: s.length, min: round(s[0] ?? NaN), p50: round(q(0.5)), p95: round(q(0.95)), max: round(s[s.length - 1] ?? NaN), mean: round(s.reduce((a, b) => a + b, 0) / (s.length || 1)) }
}

export interface BenchOptions { warmup?: number; n?: number; slowMs?: number }

/** Milliseconds per call: `warmup` unrecorded calls, then `n` recorded (3 when a warm call is slower than `slowMs`). */
export async function bench<T>(fn: () => T | Promise<T>, o: BenchOptions = {}): Promise<{ ms: Stats; last: T }> {
  let last!: T
  const warmup = o.warmup ?? 2
  let n = o.n ?? 15
  for (let i = 0; i < warmup; i += 1) {
    const t0 = performance.now()
    last = await fn()
    if (performance.now() - t0 > (o.slowMs ?? 2000)) n = Math.min(n, 3)
  }
  const samples: number[] = []
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now()
    last = await fn()
    samples.push(performance.now() - t0)
  }
  return { ms: stats(samples), last }
}

export function timeOnce<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now()
  const value = fn()
  return { ms: Math.round((performance.now() - t0) * 1000) / 1000, value }
}

/** A directory named by an environment variable: absolute, made if missing, its real path. */
export function dirFromEnv(name: string): string {
  const value = process.env[name]
  if (!value || !isAbsolute(value)) throw new Error(`${name} must name an absolute directory (run.sh sets it)`)
  mkdirSync(value, { recursive: true })
  return realpathSync(value)
}

export function intFromEnv(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback
}

/** Where the process runs: versions and machine class only. */
export function fingerprint(db?: Database): Record<string, unknown> {
  const sqlite = (db ?? new Database(':memory:')).query('select sqlite_version() AS v').get() as { v: string }
  return {
    bun: Bun.version, sqlite: sqlite.v, platform: platform(), os_release: release(), arch: arch(),
    cpu_model: cpus()[0]?.model ?? 'unknown', cpu_count: cpus().length, mem_gib: Math.round(totalmem() / 1024 ** 3),
    git: process.env.PERF_GIT_VERSION ?? null, revision: process.env.PERF_REVISION ?? null,
  }
}

/** Apparent and allocated bytes and the file count under a directory, links not followed, hard links once. */
export function du(root: string): { files: number; dirs: number; apparent_bytes: number; allocated_bytes: number } {
  const out = { files: 0, dirs: 0, apparent_bytes: 0, allocated_bytes: 0 }
  const seen = new Set<string>()
  const walk = (dir: string) => {
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const p = join(dir, name)
      let st
      try { st = lstatSync(p) } catch { continue }
      if (st.isDirectory()) { out.dirs += 1; walk(p); continue }
      const key = `${st.dev}:${st.ino}`
      if (st.nlink > 1) { if (seen.has(key)) continue; seen.add(key) }
      out.files += 1
      out.apparent_bytes += st.size
      out.allocated_bytes += st.blocks * 512
    }
  }
  if (existsSync(root)) walk(root)
  return out
}

export function fileBytes(path: string): number {
  try { return lstatSync(path).size } catch { return 0 }
}

/** The statements a piece of code runs through one connection: counted by kind and recorded (SQL text, the
 *  parameters kept in memory only, for EXPLAIN QUERY PLAN), then the connection restored. */
export interface Recorded { sql: string; params: Param[]; kind: 'all' | 'get' | 'run' }
export function recordStatements<T>(conn: Conn, fn: () => T): { value: T; statements: Recorded[] } {
  const statements: Recorded[] = []
  const all = conn.all.bind(conn), get = conn.get.bind(conn), run = conn.run.bind(conn)
  conn.all = (sql, params = []) => { statements.push({ sql, params, kind: 'all' }); return all(sql, params) }
  conn.get = (sql, params = []) => { statements.push({ sql, params, kind: 'get' }); return get(sql, params) }
  conn.run = (sql, params = []) => { statements.push({ sql, params, kind: 'run' }); return run(sql, params) }
  try { return { value: fn(), statements } } finally { delete (conn as Partial<Conn>).all; delete (conn as Partial<Conn>).get; delete (conn as Partial<Conn>).run }
}

export async function recordStatementsAsync<T>(conn: Conn, fn: () => Promise<T>): Promise<{ value: T; statements: Recorded[] }> {
  const statements: Recorded[] = []
  const all = conn.all.bind(conn), get = conn.get.bind(conn), run = conn.run.bind(conn)
  conn.all = (sql, params = []) => { statements.push({ sql, params, kind: 'all' }); return all(sql, params) }
  conn.get = (sql, params = []) => { statements.push({ sql, params, kind: 'get' }); return get(sql, params) }
  conn.run = (sql, params = []) => { statements.push({ sql, params, kind: 'run' }); return run(sql, params) }
  try { return { value: await fn(), statements } } finally { delete (conn as Partial<Conn>).all; delete (conn as Partial<Conn>).get; delete (conn as Partial<Conn>).run }
}

/** The distinct statements of a recording with their counts and query plans (plans name tables, indexes and `?`,
 *  never a bound value). */
export function planOf(conn: Conn, statements: Recorded[]): { sql: string; count: number; plan: string[] }[] {
  const by = new Map<string, { sql: string; count: number; params: Param[] }>()
  for (const s of statements) {
    const sql = s.sql.replace(/\s+/g, ' ').trim()
    const e = by.get(sql) ?? { sql, count: 0, params: s.params }
    e.count += 1
    by.set(sql, e)
  }
  return [...by.values()].map((e) => {
    let plan: string[]
    try { plan = conn.db.query(`EXPLAIN QUERY PLAN ${e.sql}`).all(...e.params).map((r) => String((r as { detail: unknown }).detail)) } catch (error) { plan = [`(no plan: ${safeError(error).name})`] }
    return { sql: e.sql, count: e.count, plan }
  })
}

/** An error as it may be printed: its class and code, never its message (a message can carry a path or a value). */
export function safeError(error: unknown): { name: string; code: string | null } {
  const e = error as { name?: unknown; code?: unknown }
  return { name: typeof e?.name === 'string' ? e.name : typeof error, code: typeof e?.code === 'string' ? e.code : null }
}

/** The result written to PERF_OUT/<name>.json (0600) and a one-line note of where. */
export function writeResult(name: string, result: Record<string, unknown>): void {
  const dir = dirFromEnv('PERF_OUT')
  const path = join(dir, `${name}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  process.stdout.write(`wrote ${name}.json to $PERF_OUT\n`)
}

/** Runs a benchmark's main: an error is said as its class and code only, and the process exits 1. */
export function main(fn: () => Promise<void>): void {
  fn().then(() => process.exit(0), (error) => {
    process.stderr.write(`benchmark failed: ${JSON.stringify(safeError(error))}\n`)
    if (process.env.PERF_DEBUG_SYNTHETIC === '1') process.stderr.write(`${(error as Error)?.stack ?? String(error)}\n`)   // synthetic runs only: they hold no user data
    process.exit(1)
  })
}

/** Refuse to run on anything inside a path given as off limits (the person's data directory), except `allowed`. */
export function assertOutside(path: string, offLimits: string | undefined, allowed: string[] = []): void {
  if (!offLimits) return
  const real = resolve(path)
  const root = resolve(offLimits)
  const inside = (a: string, b: string) => a === b || a.startsWith(b + sep)
  if (inside(real, root) && !allowed.some((a) => inside(real, resolve(a)))) throw new Error('a benchmark path is inside the off-limits data directory')
}

export function quantilePick<T>(sorted: T[], qs: number[]): { q: number; item: T }[] {
  if (!sorted.length) return []
  return qs.map((q) => ({ q, item: sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]! }))
}

/** Free bytes of the file system holding `dir`. */
export function freeBytes(dir: string): number {
  const st = statfsSync(dir)
  return Number(st.bavail) * Number(st.bsize)
}

/** Before a batch that may write `bytes` more: refused (an error, the run stops) when less than the reserve
 *  (PERF_MIN_FREE_GIB, default 6) would be left free. */
export function assertFree(dir: string, bytes: number, what: string): void {
  const reserve = intFromEnv('PERF_MIN_FREE_GIB', 6) * 1024 ** 3
  const free = freeBytes(dir)
  if (free - bytes < reserve) throw Object.assign(new Error(`not enough free disk for ${what}`), { code: 'PERF_DISK_BUDGET' })
}

/** The most a phase may generate (PERF_GEN_BUDGET_GIB, default 1 GiB): a batch over it is skipped and said so. */
export function genBudgetBytes(): number {
  return intFromEnv('PERF_GEN_BUDGET_GIB', 1) * 1024 ** 3
}
