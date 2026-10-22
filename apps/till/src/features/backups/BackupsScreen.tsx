import { formatExpiry, localDate, localTime } from '@app/core';
import { backupStatus, listBackupLog, runManualBackup, type BackupResult } from '@app/db';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useServices } from '../../app/services';
import { errorMessage } from '../../lib/errors';
import { backupFolder } from '../../platform/backup-port';
import { S } from '../../strings';
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from '../../ui';

function when(at: string, timeZone: string): string {
  const d = new Date(at);
  return `${formatExpiry(localDate(d, timeZone))} ${localTime(d, timeZone)}`;
}

function size(bytes: number | null): string {
  if (bytes === null) return '—';
  return bytes > 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

export function BackupsScreen() {
  const { ctx, backupPort } = useServices();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['backups', 'status'], queryFn: () => backupStatus(ctx) });
  const log = useQuery({ queryKey: ['backups', 'log'], queryFn: () => listBackupLog(ctx) });
  const folder = useQuery({
    queryKey: ['backups', 'folder'],
    queryFn: backupFolder,
    enabled: !!backupPort,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function backUpNow() {
    if (!backupPort) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await runManualBackup(ctx, backupPort));
      await queryClient.invalidateQueries({ queryKey: ['backups'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={S.backups.title}
        subtitle={S.backups.subtitle}
        actions={
          backupPort && (
            <Button variant="primary" disabled={busy} onClick={() => void backUpNow()}>
              {busy ? S.backups.working : S.backups.now}
            </Button>
          )
        }
      />
      {!backupPort && <Notice tone="info">{S.backups.browserOnly}</Notice>}
      {status.data?.overdue && backupPort && <Notice tone="warn">{S.backups.overdue}</Notice>}
      {error != null && <Notice tone="bad">{errorMessage(error)}</Notice>}
      {result && (
        <Notice tone={result.ok ? 'good' : 'bad'}>
          {result.ok ? S.backups.done(result.name ?? '') : S.backups.failed(result.message ?? '')}
        </Notice>
      )}
      <Card>
        <p>
          {status.data?.lastOk
            ? S.backups.lastOk(when(status.data.lastOk.at, ctx.timeZone))
            : S.backups.never}
        </p>
        {folder.data && <p className="muted">{S.backups.folder(folder.data)}</p>}
        <p className="muted">{S.backups.schedule}</p>
      </Card>
      {log.data?.length === 0 ? (
        <EmptyState>{S.backups.noLog}</EmptyState>
      ) : (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>{S.backups.when}</th>
                <th>{S.backups.kind}</th>
                <th>{S.backups.file}</th>
                <th className="num">{S.backups.size}</th>
                <th>{S.backups.result}</th>
              </tr>
            </thead>
            <tbody>
              {log.data?.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.at, ctx.timeZone)}</td>
                  <td>{S.backups.kinds[r.kind] ?? r.kind}</td>
                  <td>
                    <code>{r.fileName}</code>
                  </td>
                  <td className="num">{size(r.sizeBytes)}</td>
                  <td>
                    {r.ok ? (
                      <Badge tone="good">{S.backups.ok}</Badge>
                    ) : (
                      <Badge tone="bad">{r.error ?? '—'}</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
