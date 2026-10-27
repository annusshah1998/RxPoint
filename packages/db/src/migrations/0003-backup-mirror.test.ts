import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createKysely } from '../executor';
import { migrate } from '../migrate';
import { createNodeExecutor } from '../node';
import { initial } from './0001-initial';
import { checkout } from './0002-checkout';
import { backupMirror } from './0003-backup-mirror';

const AT = '2026-10-21T09:00:00.000Z';

const row = (id: string, mirrorStatus: string, mirrorError: string | null) =>
  sql`INSERT INTO backup_log (id, kind, file_name, status, mirror_status, mirror_error,
        started_at, finished_at)
      VALUES (${id}, 'auto', 'till-20261021-140000-auto.db', 'ok', ${mirrorStatus},
        ${mirrorError}, ${AT}, ${AT})`;

describe('0003-backup-mirror', () => {
  it('keeps the backup log and adds the mirror error', async () => {
    const db = createKysely(createNodeExecutor());
    await migrate(db, [initial, checkout]);
    await sql`INSERT INTO backup_log (id, kind, file_name, status, mirror_status, started_at,
                finished_at)
              VALUES ('old', 'manual', 'till-20261020-090000-manual.db', 'ok', 'none', ${AT},
                ${AT})`.execute(db);

    expect(await migrate(db, [initial, checkout, backupMirror])).toEqual(['0003-backup-mirror']);
    expect(
      await db.selectFrom('backup_log').select(['id', 'mirror_status', 'mirror_error']).execute(),
    ).toEqual([{ id: 'old', mirror_status: 'none', mirror_error: null }]);

    await row('a', 'failed', 'The backup drive E:\\ is not connected').execute(db);
    await row('b', 'ok', null).execute(db);
    // Only a failed copy has a reason.
    await expect(row('c', 'ok', 'Disk full').execute(db)).rejects.toThrow(/CHECK/);
    await expect(row('d', 'none', 'Disk full').execute(db)).rejects.toThrow(/CHECK/);
  });
});
