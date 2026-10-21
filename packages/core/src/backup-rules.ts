/**
 * Backup naming, when a backup is due, and which old backups to delete.
 * File names carry the store-local time so people can read them in a folder listing.
 */
export const BACKUP_KINDS = ['auto', 'shift', 'manual', 'premigrate', 'prerestore'] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

const NAME = /^till-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-([a-z]+)\.db$/;

function parts(at: Date, timeZone: string): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
}

/** "till-20261021-140500-auto.db", in the store's time zone. */
export function backupFileName(at: Date, kind: BackupKind, timeZone: string): string {
  const p = parts(at, timeZone);
  return `till-${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}-${kind}.db`;
}

export interface ParsedBackupName {
  name: string;
  /** "2026-10-21 14:05:00" (store time), sortable as text. */
  stamp: string;
  day: string;
  month: string;
  kind: string;
}

export function parseBackupFileName(name: string): ParsedBackupName | null {
  const m = NAME.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, kind] = m;
  return {
    name,
    stamp: `${y}-${mo}-${d} ${h}:${mi}:${s}`,
    day: `${y}-${mo}-${d}`,
    month: `${y}-${mo}`,
    kind: kind!,
  };
}

/**
 * A backup is due when there is none, when the last good one is over 24 hours old,
 * or when it is over 2 hours old and data has changed since (the outbox moved on).
 */
export function isBackupDue(
  last: { okAt: string | null; outboxSeq: number | null },
  now: Date,
  currentOutboxSeq: number | null,
): boolean {
  if (!last.okAt) return true;
  const lastAt = Date.parse(last.okAt);
  if (Number.isNaN(lastAt)) return true;
  const age = now.getTime() - lastAt;
  const changed = (currentOutboxSeq ?? 0) > (last.outboxSeq ?? 0);
  // The clock is behind the last backup: still back up new data, without trusting the age.
  if (age < 0) return changed;
  if (age > 24 * 3_600_000) return true;
  return age > 2 * 3_600_000 && changed;
}

/**
 * Old backups to delete. Works from the newest file's time, not the clock, so a wrong
 * clock can't wipe backups. Keeps: everything within 48 h of the newest; the newest per
 * day for the 30 most recent days; the newest per month for 12 months; the newest 3
 * pre-migration and 3 pre-restore copies; and always the newest file.
 */
export function selectBackupsToDelete(names: readonly string[]): string[] {
  const parsed = names
    .map(parseBackupFileName)
    .filter((p): p is ParsedBackupName => p !== null)
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  if (parsed.length === 0) return [];

  const keep = new Set<string>([parsed[0]!.name]);
  const newest = Date.parse(parsed[0]!.stamp.replace(' ', 'T') + 'Z');
  for (const p of parsed) {
    if (newest - Date.parse(p.stamp.replace(' ', 'T') + 'Z') <= 48 * 3_600_000) keep.add(p.name);
  }
  const firstPer = (key: (p: ParsedBackupName) => string, limit: number) => {
    const seen = new Set<string>();
    for (const p of parsed) {
      const k = key(p);
      if (seen.has(k)) continue;
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(p.name);
    }
  };
  firstPer((p) => p.day, 30);
  firstPer((p) => p.month, 12);
  for (const kind of ['premigrate', 'prerestore']) {
    parsed
      .filter((p) => p.kind === kind)
      .slice(0, 3)
      .forEach((p) => keep.add(p.name));
  }
  return parsed.filter((p) => !keep.has(p.name)).map((p) => p.name);
}
