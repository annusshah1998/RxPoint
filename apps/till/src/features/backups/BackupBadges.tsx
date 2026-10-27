import { backupStatus } from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useServices } from '../../app/services';
import { routeHash, useRoute } from '../../app/router';
import { Badge } from '../../ui';
import { backupWarnings } from './backup-view';

/** Ages change with time alone, so look again now and then. */
const RECHECK_MS = 5 * 60_000;

/**
 * Amber badges under the menu when backups are behind (§5.5). They never block anything.
 * Only the desktop app makes backups, so the browser preview shows none.
 */
export function BackupBadges({ canOpen }: { canOpen: boolean }) {
  const { ctx, backupPort } = useServices();
  const { navigate } = useRoute();
  const status = useQuery({
    queryKey: ['backups', 'status'],
    queryFn: () => backupStatus(ctx),
    enabled: !!backupPort,
    refetchInterval: RECHECK_MS,
  });
  if (!backupPort || !status.data) return null;
  const warnings = backupWarnings(status.data);
  if (warnings.length === 0) return null;
  return (
    <div className="sidebar-alerts" role="status">
      {warnings.map((w) =>
        canOpen ? (
          <a
            key={w.key}
            href={routeHash({ name: 'backups' })}
            onClick={(e) => {
              e.preventDefault();
              navigate({ name: 'backups' });
            }}
          >
            <Badge tone="warn">{w.label}</Badge>
          </a>
        ) : (
          <Badge key={w.key} tone="warn">
            {w.label}
          </Badge>
        ),
      )}
    </div>
  );
}
