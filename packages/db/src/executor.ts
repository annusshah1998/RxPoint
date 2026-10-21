import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { DB } from './schema';

export interface SqlExecResult {
  rows: Record<string, unknown>[];
  changes: number;
  lastInsertRowid: number | null;
}

/**
 * The one thing each platform has to provide: run a single SQL statement on a
 * single SQLite connection. Implementations:
 *   - desktop app: Rust command over Tauri IPC (apps/till/src/platform/tauri-executor.ts)
 *   - browser preview and e2e tests: SQLite compiled to WebAssembly
 *   - unit tests: node:sqlite (./node.ts)
 */
export interface SqlExecutor {
  execute(sql: string, params: readonly unknown[]): Promise<SqlExecResult>;
  /** Roll back a transaction left open by a previous page load, if any. */
  reset?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Serialises access to the single connection. A transaction holds the lock from
 * BEGIN to COMMIT, so no other query can slip into it while it awaits IPC.
 */
class Mutex {
  #tail: Promise<void> = Promise.resolve();

  lock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = this.#tail.then(() => release);
    this.#tail = this.#tail.then(() => next);
    return ready;
  }
}

class ExecutorConnection implements DatabaseConnection {
  constructor(private readonly executor: SqlExecutor) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.executor.execute(query.sql, query.parameters.map(toSqlValue));
    return {
      rows: result.rows as R[],
      numAffectedRows: BigInt(result.changes),
      insertId: result.lastInsertRowid == null ? undefined : BigInt(result.lastInsertRowid),
    };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming queries are not supported');
  }
}

/** SQLite has no boolean type; store true/false as 1/0. */
function toSqlValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

class ExecutorDriver implements Driver {
  readonly #mutex = new Mutex();
  readonly #connection: ExecutorConnection;
  readonly #releases = new Map<DatabaseConnection, () => void>();

  constructor(private readonly executor: SqlExecutor) {
    this.#connection = new ExecutorConnection(executor);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    const release = await this.#mutex.lock();
    // One physical connection, so the lock (not the object) is what we track.
    this.#releases.set(this.#connection, release);
    return this.#connection;
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    const release = this.#releases.get(connection);
    this.#releases.delete(connection);
    release?.();
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    // IMMEDIATE takes the write lock up front instead of failing halfway through.
    await connection.executeQuery(CompiledQuery.raw('BEGIN IMMEDIATE'));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('COMMIT'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('ROLLBACK'));
  }

  async destroy(): Promise<void> {
    await this.executor.close?.();
  }
}

class ExecutorDialect implements Dialect {
  constructor(private readonly executor: SqlExecutor) {}
  createAdapter() {
    return new SqliteAdapter();
  }
  createDriver() {
    return new ExecutorDriver(this.executor);
  }
  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createIntrospector(db: Kysely<any>) {
    return new SqliteIntrospector(db);
  }
}

export type Db = Kysely<DB>;

export function createKysely(executor: SqlExecutor): Db {
  return new Kysely<DB>({ dialect: new ExecutorDialect(executor) });
}
