// Node-only entry point (`@app/db/node`): a node:sqlite executor for tests and scripts.
// Kept out of the main entry so the app bundle never imports node:sqlite.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SqlExecutor } from './executor';

export function createNodeExecutor(path = ':memory:'): SqlExecutor {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  return {
    async execute(sql, params) {
      const statement = db.prepare(sql);
      const values = params as SQLInputValue[];
      if (statement.columns().length > 0) {
        return {
          rows: statement.all(...values) as Record<string, unknown>[],
          changes: 0,
          lastInsertRowid: null,
        };
      }
      const { changes, lastInsertRowid } = statement.run(...values);
      return { rows: [], changes: Number(changes), lastInsertRowid: Number(lastInsertRowid) };
    },
    async reset() {
      if (db.isTransaction) db.exec('ROLLBACK');
    },
    async close() {
      db.close();
    },
  };
}
