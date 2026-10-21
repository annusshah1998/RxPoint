import { createKysely, type Db, type SqlExecutor } from './executor';
import { migrate } from './migrate';

/** Opens the local database on any platform and brings its schema up to date. */
export async function openDatabase(executor: SqlExecutor): Promise<Db> {
  await executor.reset?.();
  const db = createKysely(executor);
  await migrate(db);
  return db;
}
