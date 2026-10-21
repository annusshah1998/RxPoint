import { describe, expect, it } from 'vitest';
import { createServiceContext } from '../context';
import { createNodeExecutor } from '../node';
import { openDatabase } from '../open';
import { createTestApp } from '../test-helpers';
import { getStoreInfo, listTaxClasses, loadSession, setupStore } from './setup';

describe('setupStore', () => {
  it('creates the store, till and owner on first run', async () => {
    const ctx = createServiceContext(await openDatabase(createNodeExecutor()));
    expect(await loadSession(ctx)).toBeNull();

    const session = await setupStore(ctx, {
      pharmacyName: '  City   Pharmacy ',
      tillCode: 't1',
      ownerName: 'Ali',
    });
    expect(await loadSession(ctx)).toEqual(session);
    expect(await getStoreInfo({ ...ctx, session })).toEqual({
      branchName: 'City Pharmacy',
      branchAddress: null,
      tillCode: 'T1',
      userName: 'Ali',
    });
    expect(await listTaxClasses(ctx)).toMatchObject([{ name: 'No tax', rateBp: 0 }]);
  });

  it('queues every new row for sync', async () => {
    const { db } = await createTestApp();
    const outbox = await db.selectFrom('sync_outbox').select(['table_name', 'op']).execute();
    expect(outbox.map((r) => r.table_name).sort()).toEqual(
      ['app_user', 'audit_log', 'branch', 'device', 'tax_class'].sort(),
    );
    expect(outbox.every((r) => r.op === 'insert')).toBe(true);
  });

  it('refuses to run twice', async () => {
    const { app } = await createTestApp();
    await expect(
      setupStore(app, { pharmacyName: 'Again', tillCode: 'T2', ownerName: 'X' }),
    ).rejects.toThrow(/already set up/);
  });

  it('validates input', async () => {
    const ctx = createServiceContext(await openDatabase(createNodeExecutor()));
    await expect(
      setupStore(ctx, { pharmacyName: ' ', tillCode: 'T1', ownerName: 'A' }),
    ).rejects.toMatchObject({ code: 'VALIDATION', fields: { pharmacyName: expect.any(String) } });
  });
});
