import type { BackupPort, SqlExecutor } from '@app/db';
import { isTauri } from '@tauri-apps/api/core';

export type Platform = 'desktop' | 'browser';

export function currentPlatform(): Platform {
  return isTauri() ? 'desktop' : 'browser';
}

/** The database connection for wherever the app is running. */
export async function createExecutor(): Promise<SqlExecutor> {
  if (currentPlatform() === 'desktop') {
    const { createTauriExecutor } = await import('./tauri-executor');
    return createTauriExecutor();
  }
  // Loaded only in the browser so the desktop app never downloads the WebAssembly build.
  const { createBrowserExecutor } = await import('./browser-executor');
  return createBrowserExecutor();
}

/** Backups exist only in the desktop app; the browser preview has none. */
export async function createBackupPort(platform: Platform): Promise<BackupPort | null> {
  if (platform !== 'desktop') return null;
  const { createTauriBackupPort } = await import('./backup-port');
  return createTauriBackupPort();
}
