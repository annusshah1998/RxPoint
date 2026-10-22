import {
  AppError,
  backupFileName,
  isBackupDue,
  selectBackupsToDelete,
  type BackupKind,
} from '@app/core';
import { timestamp, type AppContext, type ServiceContext } from '../context';
import type { Db } from '../executor';
import { authorizeTx, clockStateTx } from './guards';

/** What the backup check found in a copy (the desktop app's Rust side reports this). */
export interface BackupCheck {
  name: string;
  sizeBytes: number;
  integrityOk: boolean;
  /** "ok", or the problems SQLite found. */
  integrity: string;
  migrations: string[];
  saleCount: number | null;
  lastSaleAt: string | null;
  outboxSeq: number | null;
}

export interface BackupFile {
  name: string;
  sizeBytes: number;
  modifiedMs: number;
}

/**
 * Where backups are made. On the desktop it is the Rust side (a second, read-only
 * database connection copies the file, so a backup never blocks a sale); tests use a fake;
 * the browser preview has none.
 */
export interface BackupPort {
  create(name: string): Promise<BackupCheck>;
  verify(name: string): Promise<BackupCheck>;
  list(dir?: string): Promise<BackupFile[]>;
  remove(name: string, dir?: string): Promise<void>;
}

export interface BackupResult {
  ok: boolean;
  name: string | null;
  message: string | null;
}

async function outboxSeq(db: Db): Promise<number> {
  const row = await db
    .selectFrom('sync_outbox')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .executeTakeFirst();
  return Number(row?.seq ?? 0);
}

/**
 * Makes a backup now and records how it went. It never throws: a failed backup must not
 * get in the way of a sale or of closing a shift. Old copies are thinned afterwards.
 */
export async function runBackup(
  ctx: ServiceContext,
  port: BackupPort,
  kind: BackupKind,
): Promise<BackupResult> {
  const started = timestamp(ctx);
  const clock = await clockStateTx(ctx.db, ctx);
  if (clock.check.status === 'implausible') {
    // File names come from the clock; a wrong date would sort the copies wrongly.
    return { ok: false, name: null, message: 'The computer’s date is wrong; no backup made' };
  }
  const seqBefore = await outboxSeq(ctx.db);
  const name = backupFileName(ctx.now(), kind, ctx.timeZone);
  let check: BackupCheck | null = null;
  let error: string | null = null;
  try {
    check = await port.create(name);
    if (!check.integrityOk) error = `The copy failed its check: ${check.integrity}`;
    else if ((check.outboxSeq ?? 0) < seqBefore) error = 'The copy is missing recent records';
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const ok = error === null;
  await ctx.db
    .insertInto('backup_log')
    .values({
      id: ctx.newId(),
      kind,
      file_name: name,
      status: ok ? 'ok' : 'failed',
      size_bytes: check?.sizeBytes ?? null,
      outbox_seq: check?.outboxSeq ?? null,
      mirror_status: 'none',
      error,
      started_at: started,
      finished_at: timestamp(ctx),
    })
    .execute();

  if (ok && clock.check.status === 'ok') {
    try {
      const files = await port.list();
      for (const old of selectBackupsToDelete(files.map((f) => f.name))) {
        await port.remove(old).catch((err: unknown) => console.warn('Could not delete', old, err));
      }
    } catch (err) {
      console.warn('Could not tidy old backups', err);
    }
  }
  return { ok, name, message: error };
}

/** A backup made from the Backups screen (needs backup.run). */
export async function runManualBackup(ctx: AppContext, port: BackupPort): Promise<BackupResult> {
  await ctx.db.transaction().execute((trx) => authorizeTx(trx, ctx, 'backup.run'));
  return runBackup(ctx, port, 'manual');
}

export interface BackupLogRow {
  id: string;
  kind: string;
  fileName: string;
  ok: boolean;
  sizeBytes: number | null;
  error: string | null;
  at: string;
}

export async function listBackupLog(ctx: ServiceContext, limit = 50): Promise<BackupLogRow[]> {
  const rows = await ctx.db
    .selectFrom('backup_log')
    .selectAll()
    .orderBy('started_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    fileName: r.file_name,
    ok: r.status === 'ok',
    sizeBytes: r.size_bytes,
    error: r.error,
    at: r.finished_at,
  }));
}

export interface BackupStatus {
  lastOk: { at: string; name: string } | null;
  /** No good backup for more than 26 hours. */
  overdue: boolean;
  /** A backup should be made now (none yet, a day old, or 2 hours old with new records). */
  due: boolean;
}

export async function backupStatus(ctx: ServiceContext): Promise<BackupStatus> {
  const last = await ctx.db
    .selectFrom('backup_log')
    .select(['finished_at', 'file_name', 'outbox_seq'])
    .where('status', '=', 'ok')
    .orderBy('finished_at', 'desc')
    .executeTakeFirst();
  const now = ctx.now();
  const age = last ? now.getTime() - Date.parse(last.finished_at) : Infinity;
  return {
    lastOk: last ? { at: last.finished_at, name: last.file_name } : null,
    overdue: age > 26 * 3_600_000,
    due: isBackupDue(
      { okAt: last?.finished_at ?? null, outboxSeq: last?.outbox_seq ?? null },
      now,
      await outboxSeq(ctx.db),
    ),
  };
}

/** Checks an existing backup file (opens it read-only and runs SQLite's integrity check). */
export async function verifyBackup(
  ctx: AppContext,
  port: BackupPort,
  name: string,
): Promise<BackupCheck> {
  await ctx.db.transaction().execute((trx) => authorizeTx(trx, ctx, 'backup.run'));
  try {
    return await port.verify(name);
  } catch (err) {
    throw new AppError('INVALID_STATE', err instanceof Error ? err.message : String(err));
  }
}
