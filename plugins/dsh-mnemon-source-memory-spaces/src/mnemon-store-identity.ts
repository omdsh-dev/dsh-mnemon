import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type Sqlite = typeof import('node:sqlite')
type Database = InstanceType<Sqlite['DatabaseSync']>

const USAGE_TABLES = new Set(['oplog'])
const USAGE_COLUMNS = new Set(['access_count', 'last_accessed_at', 'effective_importance', 'embedding'])
const ROW_VALUES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['edges', new Set(['weight', 'metadata', 'created_at'])],
  ['insights', new Set(['updated_at'])],
])
const SCRATCH_PREFIX = '.dsh-space-identity-'
const IDENTITY_MAX_ROWS = 500_000
const MERGE_MAX_ROWS = 2_000_000

export interface MnemonStoreIdentityOptions {
  sqlite?: () => Sqlite | undefined
  maxRows?: number
  maxMergeRows?: number
}

interface Table {
  columns: string[]
  all: string[]
  rows: Set<string>
}

interface Contents {
  identity: string
  tables: Map<string, Table>
}

function sqlite(): Sqlite | undefined {
  try {
    return process.getBuiltinModule?.('node:sqlite') as Sqlite | undefined
  } catch {
    return undefined
  }
}

function quote(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"'
}

function cell(value: unknown): unknown {
  if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString('base64') }
  if (typeof value === 'bigint') return { integer: String(value) }
  if (typeof value === 'number') return { real: Object.is(value, -0) ? '-0' : String(value) }
  return value
}

function rowDigest(columns: readonly string[], row: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(columns.map(column => cell(row[column])))).digest('base64').slice(0, 22)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left === right || Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(right)
}

function remove(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 })
  } catch {}
}

export class MnemonStoreIdentity {
  private scratch: string | undefined
  private readonly known = new WeakMap<Uint8Array, Contents | null>()
  private readonly projections = new WeakMap<Uint8Array, Map<string, Set<string> | null>>()
  private readonly module: () => Sqlite | undefined
  private readonly maxRows: number
  private remaining: number

  constructor(private readonly parent: string, options: MnemonStoreIdentityOptions = {}) {
    this.module = options.sqlite ?? sqlite
    this.maxRows = options.maxRows ?? IDENTITY_MAX_ROWS
    this.remaining = options.maxMergeRows ?? MERGE_MAX_ROWS
  }

  of(bytes: Uint8Array): string {
    return this.contents(bytes)?.identity ?? 'bytes:' + digest(bytes)
  }

  contains(outer: Uint8Array, inner: Uint8Array): boolean {
    if (sameBytes(outer, inner)) return true
    const whole = this.contents(outer)
    const part = this.contents(inner)
    if (whole === undefined || part === undefined) return false
    for (const [name, table] of part.tables) {
      const present = this.rowsOn(outer, whole, name, table.columns)
      if (present === undefined) return false
      for (const row of table.rows) if (!present.has(row)) return false
    }
    return true
  }

  merge(local: Uint8Array, incoming: Uint8Array): Uint8Array | undefined {
    if (sameBytes(local, incoming)) return local
    const mine = this.contents(local)
    const theirs = this.contents(incoming)
    if (mine === undefined || theirs === undefined) return undefined
    const missing = new Map<string, Set<string>>()
    for (const [name, table] of theirs.tables) {
      const present = this.rowsOn(local, mine, name, table.columns)
      if (present === undefined) return undefined
      const rows = new Set([...table.rows].filter(row => !present.has(row)))
      if (rows.size > 0) missing.set(name, rows)
    }
    if (missing.size === 0) return local
    const module = this.module()
    const directory = this.directory()
    if (module === undefined || directory === undefined) return undefined
    const target = join(directory, randomUUID() + '.db')
    const source = join(directory, randomUUID() + '.db')
    let writer: Database | undefined
    let reader: Database | undefined
    try {
      writeFileSync(target, local, { mode: 0o600 })
      writeFileSync(source, incoming, { mode: 0o600 })
      writer = this.open(module, target, false)
      reader = this.open(module, source, true)
      if (writer === undefined || reader === undefined) return undefined
      writer.exec('BEGIN IMMEDIATE')
      writer.exec('PRAGMA defer_foreign_keys = ON')
      for (const [name, rows] of missing) {
        const table = theirs.tables.get(name)!
        const own = mine.tables.get(name)!
        const written = table.all.filter(column => own.all.includes(column))
        const insert = writer.prepare(`INSERT INTO ${quote(name)} (${written.map(quote).join(', ')}) VALUES (${written.map(() => '?').join(', ')})`)
        const statement = reader.prepare(`SELECT ${written.map(quote).join(', ')} FROM ${quote(name)}`)
        statement.setReadBigInts(true)
        for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
          if (!this.spend()) throw new Error('the merge read limit was reached')
          if (!rows.has(rowDigest(table.columns, row))) continue
          insert.run(...written.map(column => row[column] as null | number | bigint | string | Uint8Array))
        }
      }
      writer.exec('COMMIT')
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      writer.close()
      writer = undefined
      return readFileSync(target)
    } catch {
      return undefined
    } finally {
      for (const database of [writer, reader]) {
        try {
          database?.close()
        } catch {}
      }
      for (const path of [target, source]) for (const suffix of ['', '-wal', '-shm', '-journal']) remove(path + suffix)
    }
  }

  dispose(): void {
    if (this.scratch !== undefined) remove(this.scratch)
    this.scratch = undefined
  }

  private spend(): boolean {
    this.remaining -= 1
    return this.remaining >= 0
  }

  private contents(bytes: Uint8Array): Contents | undefined {
    const known = this.known.get(bytes)
    if (known !== undefined) return known ?? undefined
    const contents = this.read(bytes)
    this.known.set(bytes, contents ?? null)
    return contents
  }

  private rowsOn(bytes: Uint8Array, contents: Contents, name: string, columns: readonly string[]): Set<string> | undefined {
    const table = contents.tables.get(name)
    if (table === undefined || !columns.every(column => table.columns.includes(column))) return undefined
    if (columns.length === table.columns.length) return table.rows
    const key = JSON.stringify([name, columns])
    const cached = this.projections.get(bytes) ?? new Map<string, Set<string> | null>()
    this.projections.set(bytes, cached)
    if (!cached.has(key)) cached.set(key, this.withCopy(bytes, true, database => this.digests(database, name, columns) ?? null) ?? null)
    return cached.get(key) ?? undefined
  }

  private digests(database: Database, name: string, columns: readonly string[]): Set<string> | undefined {
    const rows = new Set<string>()
    if (columns.length === 0) return rows
    const statement = database.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(name)}`)
    statement.setReadBigInts(true)
    let budget = this.maxRows
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      budget -= 1
      if (budget < 0 || !this.spend()) return undefined
      rows.add(rowDigest(columns, row))
    }
    return rows
  }

  private directory(): string | undefined {
    try {
      if (this.scratch === undefined) {
        for (const name of readdirSync(this.parent)) if (name.startsWith(SCRATCH_PREFIX)) remove(join(this.parent, name))
      }
      if (this.scratch === undefined || !existsSync(this.scratch)) this.scratch = mkdtempSync(join(this.parent, SCRATCH_PREFIX))
    } catch {
      return undefined
    }
    return this.scratch
  }

  private open(module: Sqlite, path: string, readOnly: boolean): Database | undefined {
    if (!existsSync(path)) return undefined
    const database = new module.DatabaseSync(path, { readOnly })
    database.exec('PRAGMA trusted_schema = OFF')
    const pages = database.prepare('PRAGMA page_count').get() as { page_count?: number | bigint } | undefined
    if (Number(pages?.page_count ?? 0) <= 0) {
      database.close()
      return undefined
    }
    return database
  }

  private withCopy<T>(bytes: Uint8Array, readOnly: boolean, use: (database: Database) => T | undefined): T | undefined {
    const module = this.module()
    if (module === undefined) return undefined
    const directory = this.directory()
    if (directory === undefined) return undefined
    const path = join(directory, randomUUID() + '.db')
    let database: Database | undefined
    try {
      writeFileSync(path, bytes, { mode: 0o600 })
      database = this.open(module, path, readOnly)
      return database === undefined ? undefined : use(database)
    } catch {
      return undefined
    } finally {
      try {
        database?.close()
      } catch {}
      for (const suffix of ['', '-wal', '-shm', '-journal']) remove(path + suffix)
    }
  }

  private read(bytes: Uint8Array): Contents | undefined {
    return this.withCopy(bytes, true, database => {
      const listed = database.prepare("SELECT name, type FROM pragma_table_list WHERE schema = 'main'").all() as Array<{ name: string; type: string }>
      if (listed.some(entry => entry.type !== 'table' && entry.type !== 'view')) return undefined
      const names = listed.filter(entry => entry.type === 'table' && !entry.name.startsWith('sqlite_') && !USAGE_TABLES.has(entry.name))
        .map(entry => entry.name).sort()
      const hash = createHash('sha256')
      const tables = new Map<string, Table>()
      let budget = this.maxRows
      for (const name of names) {
        const all = (database.prepare(`PRAGMA table_info(${quote(name)})`).all() as Array<{ name: string }>).map(column => column.name)
        const columns = all.filter(column => !USAGE_COLUMNS.has(column) && ROW_VALUES.get(name)?.has(column) !== true).sort()
        const rows: string[] = []
        if (columns.length > 0) {
          const statement = database.prepare(`SELECT ${columns.map(quote).join(', ')} FROM ${quote(name)}`)
          statement.setReadBigInts(true)
          for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
            budget -= 1
            if (budget < 0 || !this.spend()) return undefined
            rows.push(rowDigest(columns, row))
          }
        }
        rows.sort()
        hash.update(JSON.stringify(['table', name, columns, rows.length]))
        for (const row of rows) hash.update(row)
        tables.set(name, { columns, all, rows: new Set(rows) })
      }
      return { identity: 'content:' + hash.digest('hex'), tables }
    })
  }
}
