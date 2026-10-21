import { describe, expect, it } from 'vitest';
import { createServiceContext } from '../context';
import { createNodeExecutor } from '../node';
import { openDatabase } from '../open';
import { createTestApp } from '../test-helpers';
import { getStoreInfo, listTaxClasses, loadDevice, setupStore } from './setup';

const PIN = { ownerPin: '246810', ownerPinRepeat: '246810' };

async function freshContext() {
  return createServiceContext(await openDatabase(createNodeExecutor()), { pinIterations: 1_000 });
}

describe('setupStore', () => {
  it('creates the store, till and owner on first run', async () => {
    const ctx = await freshContext();
    expect(await loadDevice(ctx)).toBeNull();

    const { session, recoveryCode } = await setupStore(ctx, {
      pharmacyName: '  City   Pharmacy ',
      tillCode: 't1',
      ownerName: 'Ali',
      ...PIN,
    });
    expect(recoveryCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await loadDevice(ctx)).toEqual({
      branchId: session.branchId,
      deviceId: session.deviceId,
    });
    expect(await getStoreInfo({ ...ctx, session })).toEqual({
      branchName: 'City Pharmacy',
      branchAddress: null,
      branchPhone: null,
      tillCode: 'T1',
      userName: 'Ali',
      userRole: 'owner',
    });
    expect(await listTaxClasses(ctx)).toMatchObject([{ name: 'No tax', rateBp: 0 }]);

    // Neither the PIN nor the recovery code is stored in the clear.
    const meta = await ctx.db.selectFrom('local_meta').selectAll().execute();
    const user = await ctx.db.selectFrom('app_user').select('pin_hash').executeTakeFirstOrThrow();
    const stored = JSON.stringify([meta, user]);
    expect(stored).not.toContain('246810');
    expect(stored).not.toContain(recoveryCode.replace(/-/g, ''));
    expect(user.pin_hash).toMatch(/^pbkdf2-sha256\$1000\$/);
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
    const { ctx } = await createTestApp();
    await expect(
      setupStore(ctx, { pharmacyName: 'Again', tillCode: 'T2', ownerName: 'X', ...PIN }),
    ).rejects.toThrow(/already set up/);
  });

  it('validates input', async () => {
    const ctx = await freshContext();
    await expect(
      setupStore(ctx, { pharmacyName: ' ', tillCode: 'T1', ownerName: 'A', ...PIN }),
    ).rejects.toMatchObject({ code: 'VALIDATION', fields: { pharmacyName: expect.any(String) } });
    await expect(
      setupStore(ctx, { pharmacyName: 'P', tillCode: '1-A', ownerName: 'A', ...PIN }),
    ).rejects.toMatchObject({ fields: { tillCode: expect.any(String) } });
  });

  it.each([
    ['1234', '1234', 'ownerPin', /6 digits/],
    ['123456', '123456', 'ownerPin', /easy to guess/],
    ['999999', '999999', 'ownerPin', /easy to guess/],
    ['246810', '246811', 'ownerPinRepeat', /don’t match/],
  ])('refuses the owner PIN %s / %s', async (ownerPin, ownerPinRepeat, field, message) => {
    const ctx = await freshContext();
    const error = await setupStore(ctx, {
      pharmacyName: 'P',
      tillCode: 'T1',
      ownerName: 'A',
      ownerPin,
      ownerPinRepeat,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'VALIDATION', fields: { [field]: message } });
    expect(await loadDevice(ctx)).toBeNull();
  });
});
