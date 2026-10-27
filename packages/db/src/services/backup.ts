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
import { getDeviceSettingsTx, isFullFolderPath, MIRROR_DIR_HINT } from './settings';

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
  /** The backups folder, or `dir` (the mirror), newest first. */
  list(dir?: string): Promise<BackupFile[]>;
  remove(name: string, dir?: string): Promise<void>;
  /** Copies a backup into `destDir` (the mirror), which must already exist. */
  copyTo(name: string, destDir: string): Promise<void>;
  /** [Test folder]: creates `dir` if its drive is connected and checks it can be written. */
  checkFolder(dir: string): Promise<void>;
}

export type MirrorStatus = 'none' | 'ok' | 'failed';

export interface BackupResult {
  ok: boolean;
  name: string | null;
  message: string | null;
  /** The copy to the mirror folder: 'none' when no folder is set or the backup failed. */
  mirror: MirrorStatus;
  mirrorMessage: string | null;
}

/** The mirror counts as out of date when its newest copy is older than this. */
export const MIRROR_OVERDUE_MS = 3 * 24 * 3_600_000;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function outboxSeq(db: Db): Promise<number> {
  const row = await db
    .selectFrom('sync_outbox')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .executeTakeFirst();
  return Number(row?.seq ?? 0);
}

/** Thins old copies in the backups folder, or in `dir` (the mirror), by the same rule. */
async function prune(port: BackupPort, dir?: string): Promise<void> {
  try {
    const files = await port.list(dir);
    for (const old of selectBackupsToDelete(files.map((f) => f.name))) {
      await port
        .remove(old, dir)
        .catch((err: unknown) => console.warn('Could not delete', old, dir ?? '', err));
    }
  } catch (err) {
    console.warn('Could not tidy old backups', dir ?? '', err);
  }
}

/**
 * Makes a backup now, copies it to the mirror folder if one is set, and records how it
 * went. It never throws: a failed backup must not get in the way of a sale or of closing a
 * shift, and a failed copy to the mirror (a USB stick that was pulled out) never fails
 * the backup. Old copies are thinned afterwards, in both folders.
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
    return {
      ok: false,
      name: null,
      message: 'The computer’s date is wrong; no backup made',
      mirror: 'none',
      mirrorMessage: null,
    };
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
    error = messageOf(err);
  }
  const ok = error === null;

  let mirror: MirrorStatus = 'none';
  let mirrorError: string | null = null;
  let mirrorDir: string | null = null;
  if (ok) {
    try {
      mirrorDir = (await getDeviceSettingsTx(ctx.db)).backup.mirrorDir;
      if (mirrorDir) {
        await port.copyTo(name, mirrorDir);
        mirror = 'ok';
      }
    } catch (err) {
      mirror = 'failed';
      mirrorError = messageOf(err) || 'The copy failed';
    }
  }

  await ctx.db
    .insertInto('backup_log')
    .values({
      id: ctx.newId(),
      kind,
      file_name: name,
      status: ok ? 'ok' : 'failed',
      size_bytes: check?.sizeBytes ?? null,
      outbox_seq: check?.outboxSeq ?? null,
      mirror_status: mirror,
      mirror_error: mirrorError,
      error,
      started_at: started,
      finished_at: timestamp(ctx),
    })
    .execute();

  if (ok && clock.check.status === 'ok') {
    await prune(port);
    if (mirror === 'ok' && mirrorDir) await prune(port, mirrorDir);
  }
  return { ok, name, message: error, mirror, mirrorMessage: mirrorError };
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
  mirror: MirrorStatus;
  mirrorError: string | null;
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
    mirror: r.mirror_status,
    mirrorError: r.mirror_error,
    at: r.finished_at,
  }));
}

export interface MirrorState {
  /** The mirror folder set for this till. */
  dir: string;
  /** When a backup was last copied there. */
  lastCopyAt: string | null;
  /** Why the newest copy failed; null when it worked or none was tried yet. */
  lastError: string | null;
}

export interface BackupStatus {
  lastOk: { at: string; name: string } | null;
  /** No good backup for more than 26 hours. */
  overdue: boolean;
  /** A backup should be made now (none yet, a day old, or 2 hours old with new records). */
  due: boolean;
  /** Null when no mirror folder is set on this till. */
  mirror: MirrorState | null;
  /** A mirror folder is set and holds nothing newer than 3 days. */
  mirrorOverdue: boolean;
}

/** The newest good backup with this mirror status, or the oldest one after `after`. */
function mirrorRow(
  db: Db,
  status: MirrorStatus,
  options: { after?: string | undefined; oldest?: boolean } = {},
) {
  let query = db
    .selectFrom('backup_log')
    .select(['finished_at', 'mirror_error'])
    .where('status', '=', 'ok')
    .where('mirror_status', '=', status);
  if (options.after) query = query.where('finished_at', '>', options.after);
  return query.orderBy('finished_at', options.oldest ? 'asc' : 'desc').executeTakeFirst();
}

/**
 * When the mirror was last up to date: its newest copy; or, when copies have only failed
 * since the folder was set (since the last backup made with no folder), the first of
 * those failures. Null before any copy was tried.
 */
async function mirrorSince(db: Db, copiedAt: string | null): Promise<string | null> {
  const off = await mirrorRow(db, 'none');
  if (copiedAt && (!off || copiedAt > off.finished_at)) return copiedAt;
  const firstFailure = await mirrorRow(db, 'failed', { after: off?.finished_at, oldest: true });
  return firstFailure?.finished_at ?? null;
}

export async function backupStatus(ctx: ServiceContext): Promise<BackupStatus> {
  const last = await ctx.db
    .selectFrom('backup_log')
    .select(['finished_at', 'file_name', 'outbox_seq', 'mirror_status', 'mirror_error'])
    .where('status', '=', 'ok')
    .orderBy('finished_at', 'desc')
    .executeTakeFirst();
  const now = ctx.now();
  const age = last ? now.getTime() - Date.parse(last.finished_at) : Infinity;

  const dir = (await getDeviceSettingsTx(ctx.db)).backup.mirrorDir;
  let mirror: MirrorState | null = null;
  let mirrorOverdue = false;
  if (dir) {
    const lastCopyAt = (await mirrorRow(ctx.db, 'ok'))?.finished_at ?? null;
    const since = await mirrorSince(ctx.db, lastCopyAt);
    mirror = {
      dir,
      lastCopyAt,
      lastError: last?.mirror_status === 'failed' ? last.mirror_error : null,
    };
    mirrorOverdue = since !== null && now.getTime() - Date.parse(since) > MIRROR_OVERDUE_MS;
  }

  return {
    lastOk: last ? { at: last.finished_at, name: last.file_name } : null,
    overdue: age > 26 * 3_600_000,
    due: isBackupDue(
      { okAt: last?.finished_at ?? null, outboxSeq: last?.outbox_seq ?? null },
      now,
      await outboxSeq(ctx.db),
    ),
    mirror,
    mirrorOverdue,
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
    throw new AppError('INVALID_STATE', messageOf(err));
  }
}

/**
 * [Test folder] in Settings → Backups (needs settings.edit): creates the mirror folder if
 * its drive is connected, and checks a file can be written there. Problems come back on
 * the field, worded by the desktop app ("The backup drive E:\ is not connected").
 */
export async function checkBackupFolder(
  ctx: AppContext,
  port: BackupPort,
  dir: string,
): Promise<void> {
  await ctx.db.transaction().execute((trx) => authorizeTx(trx, ctx, 'settings.edit'));
  const path = dir.trim();
  if (!isFullFolderPath(path)) {
    throw new AppError('VALIDATION', MIRROR_DIR_HINT, { 'backup.mirrorDir': MIRROR_DIR_HINT });
  }
  try {
    await port.checkFolder(path);
  } catch (err) {
    const message = messageOf(err);
    throw new AppError('INVALID_STATE', message, { 'backup.mirrorDir': message });
  }
}
