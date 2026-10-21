import type { SqlExecutor } from '@app/db';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const STORAGE_NAME = 'local';

/**
 * Browser preview: SQLite compiled to WebAssembly, saved in this browser's
 * localStorage. For trying the app and for end-to-end tests; real pharmacies use
 * the desktop app, where data lives in a file on disk.
 */
export async function createBrowserExecutor(): Promise<SqlExecutor> {
  const sqlite3 = await sqlite3InitModule();
  let db: InstanceType<typeof sqlite3.oo1.DB>;
  try {
    db = new sqlite3.oo1.JsStorageDb(STORAGE_NAME);
  } catch (error) {
    console.warn('Browser storage unavailable; using a temporary in-memory database', error);
    db = new sqlite3.oo1.DB(':memory:', 'c');
  }
  db.exec('PRAGMA foreign_keys = ON');

  return {
    async execute(sql, params) {
      const statement = db.prepare(sql);
      try {
        if (params.length > 0) statement.bind(params as never);
        if (statement.columnCount === 0) {
          statement.step();
          return { rows: [], changes: db.changes(), lastInsertRowid: null };
        }
        const rows: Record<string, unknown>[] = [];
        while (statement.step()) rows.push(statement.get({}) as Record<string, unknown>);
        return { rows, changes: 0, lastInsertRowid: null };
      } finally {
        statement.finalize();
      }
    },
    async reset() {
      if (!sqlite3.capi.sqlite3_get_autocommit(db)) db.exec('ROLLBACK');
    },
  };
}

/** Deletes the browser preview database. */
export async function clearBrowserData(): Promise<void> {
  const sqlite3 = await sqlite3InitModule();
  new sqlite3.oo1.JsStorageDb(STORAGE_NAME).clearStorage();
}
