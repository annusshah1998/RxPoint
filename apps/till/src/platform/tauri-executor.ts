import type { SqlExecResult, SqlExecutor } from '@app/db';
import { invoke } from '@tauri-apps/api/core';

/** Runs SQL in the Rust side of the desktop app (src-tauri/src/db.rs). */
export function createTauriExecutor(): SqlExecutor {
  return {
    async execute(sql, params) {
      try {
        return await invoke<SqlExecResult>('db_execute', { sql, params });
      } catch (error) {
        // Rust returns errors as plain strings.
        throw new Error(typeof error === 'string' ? error : String(error), { cause: error });
      }
    },
    async reset() {
      await invoke('db_reset');
    },
  };
}
