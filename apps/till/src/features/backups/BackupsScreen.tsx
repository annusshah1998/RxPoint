import {
  backupStatus,
  listBackupLog,
  runManualBackup,
  verifyBackup,
  type BackupLogRow,
  type BackupResult,
} from '@app/db';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useServices } from '../../app/services';
import { errorMessage } from '../../lib/errors';
import { backupFolder } from '../../platform/backup-port';
import { S } from '../../strings';
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from '../../ui';
import { formatDateTime } from '../clock/clock-view';
import { checkSummary } from './backup-view';

function size(bytes: number | null): string {
  if (bytes === null) return '—';
  return bytes > 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function resultText(result: BackupResult): string {
  if (!result.ok) return S.backups.failed(result.message ?? '');
  const name = result.name ?? '';
  if (result.mirror === 'ok') return S.backups.doneAndCopied(name);
  if (result.mirror === 'failed') return S.backups.doneNotCopied(name, result.mirrorMessage ?? '');
  return S.backups.done(name);
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
  // Which logged backups are still on disk (retention thins old ones), so [Check] shows
  // only where there is a file to check.
  const files = useQuery({
    queryKey: ['backups', 'files'],
    queryFn: async () => new Set((await backupPort!.list()).map((f) => f.name)),
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

  const mirror = status.data?.mirror;
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
      {status.data?.mirrorOverdue && mirror && backupPort && (
        <Notice tone="warn">
          {S.backups.mirrorOverdue(mirror.dir)}
          {mirror.lastError && (
            <>
              <br />
              {S.backups.lastTry(mirror.lastError)}
            </>
          )}
        </Notice>
      )}
      {error != null && <Notice tone="bad">{errorMessage(error)}</Notice>}
      {result && (
        <Notice tone={!result.ok ? 'bad' : result.mirror === 'failed' ? 'warn' : 'good'}>
          {resultText(result)}
        </Notice>
      )}
      <Card>
        <p>
          {status.data?.lastOk
            ? S.backups.lastOk(formatDateTime(status.data.lastOk.at, ctx.timeZone))
            : S.backups.never}
        </p>
        {folder.data && <p className="muted">{S.backups.folder(folder.data)}</p>}
        {backupPort && status.data && (
          <p className="muted">
            {mirror
              ? S.backups.mirrorLine(
                  mirror.dir,
                  mirror.lastCopyAt ? formatDateTime(mirror.lastCopyAt, ctx.timeZone) : null,
                )
              : S.backups.noMirror}
          </p>
        )}
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
                <th>{S.backups.mirrorColumn}</th>
                {backupPort && <th>{S.backups.checkColumn}</th>}
              </tr>
            </thead>
            <tbody>
              {log.data?.map((r) => (
                <tr key={r.id}>
                  <td>{formatDateTime(r.at, ctx.timeZone)}</td>
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
                  <td>
                    <MirrorCell row={r} />
                  </td>
                  {backupPort && (
                    <td>
                      {r.ok && files.data?.has(r.fileName) ? (
                        <CheckCell name={r.fileName} />
                      ) : r.ok && files.data ? (
                        <span className="muted" title={S.backups.thinnedHint}>
                          {S.backups.thinned}
                        </span>
                      ) : null}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function MirrorCell({ row }: { row: BackupLogRow }) {
  if (row.mirror === 'ok') return <Badge tone="good">{S.backups.copied}</Badge>;
  if (row.mirror === 'failed') {
    return (
      <span title={row.mirrorError ?? undefined}>
        <Badge tone="warn">{S.backups.notCopied}</Badge>
      </span>
    );
  }
  return <span className="muted">—</span>;
}

/** [Check]: opens the file read-only and runs SQLite's integrity check (verifyBackup). */
function CheckCell({ name }: { name: string }) {
  const { ctx, backupPort } = useServices();
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<
    { ok: boolean; label: string; detail: string } | { error: unknown } | null
  >(null);

  async function check() {
    if (!backupPort) return;
    setChecking(true);
    setOutcome(null);
    try {
      setOutcome(checkSummary(await verifyBackup(ctx, backupPort, name), ctx.timeZone));
    } catch (error) {
      setOutcome({ error });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="backup-check">
      <Button
        size="small"
        disabled={checking}
        onClick={() => void check()}
        aria-label={S.backups.checkFor(name)}
      >
        {checking ? S.backups.checking : S.backups.check}
      </Button>
      <span role="status">
        {outcome &&
          ('error' in outcome ? (
            <Badge tone="bad">{errorMessage(outcome.error)}</Badge>
          ) : (
            <>
              <Badge tone={outcome.ok ? 'good' : 'bad'}>{outcome.label}</Badge>{' '}
              <span className={outcome.ok ? 'muted' : undefined}>{outcome.detail}</span>
            </>
          ))}
      </span>
    </div>
  );
}
