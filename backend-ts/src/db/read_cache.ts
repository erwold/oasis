/** Bounded, connection-local memoization of synchronous DB-derived reads. Not a TTL: any DB write invalidates
 *  the values. In-memory runtime state (handles, permissions, config) must be read outside this cache. */
import type { Conn } from './database.ts'

interface Bucket<V> { revision: string; bytes: number; entries: Map<string, { value: V; bytes: number }> }

function revision(conn: Conn): string | null {
  // Never publish a transaction's tentative values, including one opened directly on conn.db. This also makes
  // rollback/savepoint reads safe: total_changes does not roll back, but it is not itself a commit sequence.
  if (conn.db.inTransaction) return null
  const row = conn.get('SELECT total_changes() AS writes, data_version AS external, schema_version AS schema FROM pragma_data_version, pragma_schema_version')!
  return `${row.writes}/${row.external}/${row.schema}`
}

export class DbReadCache<V> {
  private readonly buckets = new WeakMap<Conn, Bucket<V>>()
  constructor(private readonly maxEntries: number, private readonly maxBytes: number, private readonly size: (value: V) => number) {}

  /** Values are private to the caller: clone before returning mutable objects outside the owning module. */
  read(conn: Conn, key: string, load: () => V): V {
    const before = revision(conn)
    let bucket = this.buckets.get(conn)
    if (before === null) { this.buckets.delete(conn); return load() }
    if (bucket?.revision !== before) {
      bucket = { revision: before, bytes: 0, entries: new Map() }
      this.buckets.set(conn, bucket)
    }
    const hit = bucket.entries.get(key)
    if (hit) {
      bucket.entries.delete(key)
      bucket.entries.set(key, hit)
      return hit.value
    }
    const value = load()
    // A different connection can commit while the synchronous read is running. Do not retain a result across
    // that boundary. No promise/await is allowed in load; the request still has normal multi-statement read semantics.
    if (revision(conn) !== before) { this.buckets.delete(conn); return value }
    const bytes = this.size(value) + key.length * 2 + 64
    if (bytes > this.maxBytes || this.maxEntries < 1) return value
    while (bucket.entries.size >= this.maxEntries || bucket.bytes + bytes > this.maxBytes) {
      const oldest = bucket.entries.keys().next().value!
      bucket.bytes -= bucket.entries.get(oldest)!.bytes
      bucket.entries.delete(oldest)
    }
    bucket.entries.set(key, { value, bytes })
    bucket.bytes += bytes
    return value
  }
}

/** Serialized UTF-16 size, with room for object/array overhead. A retention budget, not a heap measurement. */
export function jsonWeight(value: unknown): number { return JSON.stringify(value).length * 2 + 256 }
