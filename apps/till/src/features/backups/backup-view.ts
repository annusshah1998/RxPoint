import type { BackupCheck, BackupStatus } from '@app/db';
import { S } from '../../strings';
import { formatDateTime } from '../clock/clock-view';

export interface BackupWarning {
  key: 'overdue' | 'mirror';
  label: string;
}

/**
 * The amber badges beside the menu (§5.5): no good backup for 26 hours, and nothing
 * copied to the backup drive for 3 days. Neither stops a sale.
 */
export function backupWarnings(
  status: Pick<BackupStatus, 'overdue' | 'mirrorOverdue'>,
): BackupWarning[] {
  const warnings: BackupWarning[] = [];
  if (status.overdue) warnings.push({ key: 'overdue', label: S.backups.badge });
  if (status.mirrorOverdue) warnings.push({ key: 'mirror', label: S.backups.mirrorBadge });
  return warnings;
}

/** What [Check] found in a backup file, in words. */
export function checkSummary(
  check: BackupCheck,
  timeZone: string,
): { ok: boolean; label: string; detail: string } {
  if (!check.integrityOk) {
    return {
      ok: false,
      label: S.backups.damaged,
      detail: S.backups.damagedDetail(check.integrity),
    };
  }
  const lastSale = check.lastSaleAt ? formatDateTime(check.lastSaleAt, timeZone) : null;
  return {
    ok: true,
    label: S.backups.sound,
    detail: S.backups.soundDetail(check.saleCount, lastSale),
  };
}
