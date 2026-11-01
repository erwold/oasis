import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { Conn } from '../src/db/database.ts'
import { DbReadCache } from '../src/db/read_cache.ts'
import { tempDir } from './helpers.ts'

const connections: Conn[] = []
afterEach(() => { for (const conn of connections.splice(0)) conn.close() })
function open(path = ':memory:'): Conn {
  const conn = new Conn(new Database(path), path)
  connections.push(conn)
  return conn
}
function fixture() {
  const conn = open()
  conn.exec("CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT); INSERT INTO t VALUES ('a', 'one')")
  const cache = new DbReadCache<string>(4, 1024, (s) => s.length * 2)
  let loads = 0
  const read = () => cache.read(conn, 'a', () => { loads++; return String(conn.get("SELECT value FROM t WHERE id='a'")?.value) })
  return { conn, read, loads: () => loads }
}

test('all same-connection writes invalidate, including exec, direct db and RETURNING reads', () => {
  const { conn, read, loads } = fixture()
  expect(read()).toBe('one'); expect(read()).toBe('one'); expect(loads()).toBe(1)
  conn.run("UPDATE t SET value='two'")
  expect(read()).toBe('two')
  conn.exec("UPDATE t SET value='three'")
  expect(read()).toBe('three')
  conn.db.run("UPDATE t SET value='four'")
  expect(read()).toBe('four')
  conn.db.query("UPDATE t SET value='five' RETURNING value").get()
  expect(read()).toBe('five')
  conn.get("UPDATE t SET value='six' RETURNING value")
  expect(read()).toBe('six')
  conn.all("UPDATE t SET value='seven' RETURNING value")
  expect(read()).toBe('seven'); expect(read()).toBe('seven'); expect(loads()).toBe(7)
})

test('transaction and savepoint rollback never publish tentative reads; commits remain visible', () => {
  const { conn, read } = fixture()
  expect(read()).toBe('one')
  expect(() => conn.transaction(() => {
    conn.run("UPDATE t SET value='tentative'")
    expect(read()).toBe('tentative')
    conn.exec('SAVEPOINT nested')
    conn.db.run("UPDATE t SET value='nested'")
    expect(read()).toBe('nested')
    conn.exec('ROLLBACK TO nested; RELEASE nested')
    expect(read()).toBe('tentative')
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(read()).toBe('one')
  expect(() => conn.db.transaction(() => {
    conn.db.run("UPDATE t SET value='direct tentative'")
    expect(read()).toBe('direct tentative')
    throw new Error('direct rollback')
  })()).toThrow('direct rollback')
  expect(read()).toBe('one')
  conn.exec('BEGIN')
  conn.db.run("UPDATE t SET value='manual'")
  expect(read()).toBe('manual')
  conn.exec('ROLLBACK')
  expect(read()).toBe('one')
  conn.transaction(() => { conn.run("UPDATE t SET value='committed'"); expect(read()).toBe('committed') })
  expect(read()).toBe('committed')
})

test('external commits invalidate; a commit during load cannot poison the next read', () => {
  const path = join(tempDir(), 'memo.db')
  const conn = open(path)
  conn.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(value); INSERT INTO t VALUES ('one')")
  const other = open(path)
  const cache = new DbReadCache<string>(2, 1024, () => 8)
  let loads = 0
  let during = false
  const read = () => cache.read(conn, 'key', () => {
    loads++
    const value = String(conn.get('SELECT value FROM t')!.value)
    if (during) { during = false; other.run("UPDATE t SET value='three'") }
    return value
  })
  expect(read()).toBe('one'); expect(read()).toBe('one'); expect(loads).toBe(1)
  other.run("UPDATE t SET value='two'")
  during = true
  expect(read()).toBe('two')
  expect(read()).toBe('three'); expect(read()).toBe('three'); expect(loads).toBe(3)
  other.exec('BEGIN')
  other.run("UPDATE t SET value='uncommitted'")
  expect(read()).toBe('three')
  other.exec('ROLLBACK')
  expect(read()).toBe('three')
})

test('delete/recreate and schema changes cannot reuse old values; connections are separate', () => {
  const { conn, read } = fixture()
  expect(read()).toBe('one')
  conn.exec("DELETE FROM t; INSERT INTO t VALUES ('a','new')")
  expect(read()).toBe('new')
  // DDL need not increment total_changes.
  conn.exec('DROP TABLE t; CREATE TABLE t(id TEXT PRIMARY KEY, value TEXT)')
  expect(read()).toBe('undefined')
  const other = open()
  const cache = new DbReadCache<string>(2, 1024, () => 8)
  expect(cache.read(conn, 'same', () => 'first')).toBe('first')
  expect(cache.read(other, 'same', () => 'second')).toBe('second')
})

test('LRU entry and byte budgets evict; an oversized value is returned whole but never retained', () => {
  const conn = open()
  const cache = new DbReadCache<string>(2, 204, (s) => s.length)
  const loads: string[] = []
  const read = (key: string, value = 'x'.repeat(30)) => cache.read(conn, key, () => { loads.push(key); return value })
  read('a'); read('b'); read('a'); read('c'); read('b')
  expect(loads).toEqual(['a', 'b', 'c', 'b'])
  const large = 'z'.repeat(1000)
  expect(read('large', large)).toBe(large); expect(read('large', large)).toBe(large)
  expect(loads.slice(-2)).toEqual(['large', 'large'])
  const bytes = new DbReadCache<string>(100, 100, (s) => s.length)
  let n = 0
  for (const key of ['a', 'b', 'a']) bytes.read(conn, key, () => { n++; return 'x'.repeat(20) })
  expect(n).toBe(3)
})
