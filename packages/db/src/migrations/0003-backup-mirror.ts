import type { Migration } from './types';

/**
 * M2b: why a backup's copy to the mirror folder (a USB stick or another drive) failed,
 * so the Backups screen can say so. Only a 'failed' mirror has one.
 */
export const backupMirror: Migration = {
  id: '0003-backup-mirror',
  statements: [
    `ALTER TABLE backup_log ADD COLUMN mirror_error TEXT
       CHECK (mirror_error IS NULL OR mirror_status = 'failed')`,
  ],
};
