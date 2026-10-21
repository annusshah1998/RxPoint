import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createKysely } from './executor';
import { migrate } from './migrate';
import { MIGRATIONS } from './migrations';
import { createNodeExecutor } from './node';
import { openDatabase } from './open';
import { createProduct } from './services/catalog';
import { addOpeningStock } from './services/stock';
import { createTestApp, tabletInput } from './test-helpers';

describe('migrations', () => {
  it('apply once and record themselves', async () => {
    const db = createKysely(createNodeExecutor());
    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(await migrate(db)).toEqual([]);
    const rows = await db.selectFrom('schema_migration').select('id').execute();
    expect(rows.map((r) => r.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('refuse a database from a newer app version', async () => {
    const db = await openDatabase(createNodeExecutor());
    await db
      .insertInto('schema_migration')
      .values({ id: '9999-future', applied_at: new Date().toISOString() })
      .execute();
    await expect(migrate(db)).rejects.toThrow(/newer version/);
  });

  it('roll back a failing migration completely', async () => {
    const db = createKysely(createNodeExecutor());
    await expect(
      migrate(db, [{ id: '0001-bad', statements: ['CREATE TABLE ok (id TEXT)', 'NOT SQL'] }]),
    ).rejects.toThrow();
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ok'
    `.execute(db);
    expect(tables.rows).toEqual([]);
  });
});

describe('schema guards', () => {
  it('rejects fractional money and quantities (STRICT tables)', async () => {
    const db = await openDatabase(createNodeExecutor());
    await expect(
      sql`INSERT INTO tax_class (id, name, rate_bp, is_active, created_at, updated_at)
          VALUES ('t', 'x', 1.5, 1, '', '')`.execute(db),
    ).rejects.toThrow();
  });

  it('keeps the stock ledger and audit log append-only', async () => {
    const { app, db } = await createTestApp();
    const product = await createProduct(app, tabletInput());
    await addOpeningStock(app, { productId: product.id, qty: 5, expiryDate: null });
    await expect(sql`UPDATE stock_movement SET qty = 1`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM stock_movement`.execute(db)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM audit_log`.execute(db)).rejects.toThrow(/append-only/);
  });
});

describe('connection lock', () => {
  it('keeps other queries out of an open transaction', async () => {
    const db = await openDatabase(createNodeExecutor());
    const events: string[] = [];
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => (resume = resolve));

    const tx = db.transaction().execute(async (trx) => {
      await trx.insertInto('local_meta').values({ key: 'a', value: '1' }).execute();
      events.push('tx inserted');
      await paused; // e.g. waiting on IPC
      events.push('tx committing');
    });
    // Give the transaction time to start, then query from outside it.
    await new Promise((r) => setTimeout(r, 10));
    const outside = db
      .selectFrom('local_meta')
      .selectAll()
      .execute()
      .then((rows) => {
        events.push(`outside saw ${rows.length}`);
      });
    await new Promise((r) => setTimeout(r, 10));
    resume();
    await Promise.all([tx, outside]);

    expect(events).toEqual(['tx inserted', 'tx committing', 'outside saw 1']);
  });

  it('releases the lock after a failed transaction', async () => {
    const db = await openDatabase(createNodeExecutor());
    await expect(
      db.transaction().execute(async (trx) => {
        await trx.insertInto('local_meta').values({ key: 'a', value: '1' }).execute();
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await db.selectFrom('local_meta').selectAll().execute()).toEqual([]);
  });
});
