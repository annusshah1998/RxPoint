import type { BackupCheck, BackupFile, BackupPort } from '@app/db';
import { invoke } from '@tauri-apps/api/core';

function fail(error: unknown): never {
  // Rust returns errors as plain strings.
  throw new Error(typeof error === 'string' ? error : String(error), { cause: error });
}

/** Backups through the desktop app's Rust side (src-tauri/src/backup.rs). */
export function createTauriBackupPort(): BackupPort {
  return {
    create: (name) => invoke<BackupCheck>('backup_create', { name }).catch(fail),
    verify: (name) => invoke<BackupCheck>('backup_verify', { name }).catch(fail),
    list: (dir) => invoke<BackupFile[]>('backup_list', { dir: dir ?? null }).catch(fail),
    remove: (name, dir) => invoke<void>('backup_delete', { name, dir: dir ?? null }).catch(fail),
    copyTo: (name, destDir) => invoke<void>('backup_copy', { name, destDir }).catch(fail),
    checkFolder: (dir) => invoke<void>('folder_check', { path: dir }).catch(fail),
  };
}

/** Where backups go on this computer. */
export async function backupFolder(): Promise<string | null> {
  try {
    const info = await invoke<{ backupDir: string }>('app_info');
    return info.backupDir;
  } catch {
    return null;
  }
}
