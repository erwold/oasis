/** Summary statistics, run metadata and result files for the perf harness (synthetic data only). */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, release, totalmem } from 'node:os'
import { join, relative, resolve } from 'node:path'

export interface Summary { n: number; median: number; min: number; max: number; mean: number; p95: number | null; stdev: number }

/** median/range always; p95 only from 20 samples on (fewer cannot carry it). */
export function summarize(xs: number[]): Summary {
  const s = [...xs].sort((a, b) => a - b)
  const n = s.length
  if (!n) return { n: 0, median: NaN, min: NaN, max: NaN, mean: NaN, p95: null, stdev: NaN }
  const q = (p: number) => { const i = (n - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo]! + (s[hi]! - s[lo]!) * (i - lo) }
  const mean = s.reduce((a, b) => a + b, 0) / n
  const stdev = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1))
  return { n, median: round(q(0.5)), min: round(s[0]!), max: round(s[n - 1]!), mean: round(mean), p95: n >= 20 ? round(q(0.95)) : null, stdev: round(stdev) }
}

export function round(x: number, digits = 3): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

/** least squares y = a + b x */
export function linreg(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN }
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2 }
  const slope = sxx ? sxy / sxx : NaN
  return { slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : NaN }
}

export const BACKEND_DIR = resolve(import.meta.dir, '..', '..', '..')

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: BACKEND_DIR, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } })
  return r.status === 0 ? r.stdout.trim() : 'unknown'
}

export function loadAvg(): number[] { return loadavg().map((x) => round(x, 2)) }

export function meta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    at: new Date().toISOString(),
    git_head: git(['rev-parse', 'HEAD']), git_branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    git_dirty_src: git(['status', '--porcelain', '--', 'src', '../contract']) !== '',
    bun: Bun.version, bun_revision: Bun.revision, platform: process.platform, arch: process.arch, os_release: release(),
    cpu: cpus()[0]?.model ?? 'unknown', cpu_count: cpus().length, total_mem_gb: round(totalmem() / 1024 ** 3, 1),
    loadavg_start: loadAvg(), argv: process.argv.slice(2), ...extra,
  }
}

export function argValue(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : fallback
}
export const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`)
export const argNum = (name: string, fallback: number): number => Number(argValue(name, String(fallback)))
export const argList = (name: string, fallback: number[]): number[] => {
  const raw = argValue(name)
  return raw === undefined ? fallback : raw.split(',').filter((x) => x.trim() !== '').map(Number)
}

export const DEFAULT_OUT = join(BACKEND_DIR, 'scripts', 'perf', 'results')

/** Writes <out>/<name>.json (raw + summary) and returns its path. */
export function writeResult(name: string, data: Record<string, unknown>): string {
  const out = argValue('out', process.env.PERF_OUT ?? DEFAULT_OUT)!
  mkdirSync(out, { recursive: true })
  const path = join(out, `${name}.json`)
  writeFileSync(path, JSON.stringify({ ...data, loadavg_end: loadAvg() }, null, 2) + '\n')
  console.log(`wrote ${relative(BACKEND_DIR, path)}`)
  return path
}

export function fdCount(): number {
  try { return readdirSync('/dev/fd').length } catch { return -1 }
}

export function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

/** heap/RSS after a full GC (twice), object count from JSC */
export async function memory(): Promise<Record<string, number>> {
  Bun.gc(true); await sleep(5); Bun.gc(true)
  const { heapStats } = await import('bun:jsc')
  const h = heapStats()
  const m = process.memoryUsage()
  return { rss_mb: round(m.rss / 2 ** 20, 2), heap_used_mb: round(m.heapUsed / 2 ** 20, 2), heap_total_mb: round(m.heapTotal / 2 ** 20, 2), jsc_heap_mb: round(h.heapSize / 2 ** 20, 2), objects: h.objectCount, protected_objects: h.protectedObjectCount, fds: fdCount() }
}

export async function timeIt<T>(fn: () => T | Promise<T>): Promise<[number, T]> {
  const t0 = performance.now()
  const v = await fn()
  return [performance.now() - t0, v]
}

export function sha(text: string): string {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex').slice(0, 16)
}
