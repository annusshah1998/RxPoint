import { backupStatus, runBackup } from '@app/db';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useServices } from '../../app/services';

const CHECK_EVERY_MS = 10 * 60_000;

/**
 * Backs up in the background while someone is logged in: at login when the last good
 * copy is a day old, and every 2 hours when there are new records. The copy is made on a
 * second connection, so selling carries on meanwhile.
 */
export function useBackupSchedule() {
  const { ctx, backupPort } = useServices();
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!backupPort) return;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        if ((await backupStatus(ctx)).due) {
          await runBackup(ctx, backupPort, 'auto');
          await queryClient.invalidateQueries({ queryKey: ['backups'] });
        }
      } catch (error) {
        console.error('Background backup failed', error);
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), CHECK_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [ctx, backupPort, queryClient]);
}
