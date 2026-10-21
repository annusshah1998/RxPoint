import { sql } from 'kysely';
import type { Db } from './executor';
import { MIGRATIONS, type Migration } from './migrations';

/** Applies pending migrations, each in its own transaction. Returns the ids applied. */
export async function migrate(
  db: Db,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migration (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  ) STRICT`.execute(db);

  const done = new Set(
    (await db.selectFrom('schema_migration').select('id').execute()).map((row) => row.id),
  );

  const ids = migrations.map((m) => m.id);
  const sorted = [...ids].sort();
  if (ids.some((id, i) => id !== sorted[i]) || new Set(ids).size !== ids.length) {
    throw new Error('Migrations must have unique ids in ascending order');
  }
  const unknown = [...done].filter((id) => !ids.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `This database was created by a newer version of the app (${unknown.join(', ')}). ` +
        'Install the latest version.',
    );
  }

  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    await db.transaction().execute(async (trx) => {
      for (const statement of migration.statements) {
        await sql.raw(statement).execute(trx);
      }
      await trx
        .insertInto('schema_migration')
        .values({ id: migration.id, applied_at: now().toISOString() })
        .execute();
    });
    applied.push(migration.id);
  }
  return applied;
}
