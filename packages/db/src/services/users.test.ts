import { describe, expect, it } from 'vitest';
import { asRole, createTestApp } from '../test-helpers';
import { listLoginUsers, login } from './auth';
import {
  DEFAULT_DEVICE_SETTINGS,
  getDeviceSettings,
  getStoreSettings,
  updateDeviceSettings,
  updateStoreSettings,
} from './settings';
import { createUser, listUsers, resetUserPin, unlockUser, updateUser } from './users';

describe('users', () => {
  it('lets the owner add staff, who can then log in', async () => {
    const t = await createTestApp();
    const user = await createUser(t.app, {
      name: 'Sana',
      role: 'cashier',
      pin: '1470',
      pinRepeat: '1470',
    });
    await login(t.ctx, { userId: user.id, pin: '1470' });
    expect((await listLoginUsers(t.ctx)).map((u) => [u.name, u.role])).toEqual([
      ['Owner', 'owner'],
      ['Sana', 'cashier'],
    ]);
    await expect(
      createUser(t.app, { name: ' sana ', role: 'pharmacist', pin: '2580', pinRepeat: '2580' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
    // A new owner needs a 6-digit PIN.
    await expect(
      createUser(t.app, { name: 'Zara', role: 'owner', pin: '2580', pinRepeat: '2580' }),
    ).rejects.toMatchObject({ fields: { pin: 'Use exactly 6 digits' } });
  });

  it('is for the owner only', async () => {
    const t = await createTestApp();
    const pharmacist = await asRole(t, 'pharmacist');
    await expect(listUsers(pharmacist.app)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      createUser(pharmacist.app, { name: 'X', role: 'cashier', pin: '1470', pinRepeat: '1470' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('keeps at least one owner and stops you switching yourself off', async () => {
    const t = await createTestApp();
    const me = t.app.session.userId;
    await expect(updateUser(t.app, me, { role: 'pharmacist' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'The store needs at least one owner',
    });
    await expect(updateUser(t.app, me, { isActive: false })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });

    const second = await createUser(t.app, {
      name: 'Partner',
      role: 'owner',
      pin: '975310',
      pinRepeat: '975310',
    });
    await updateUser(t.app, second.id, { role: 'pharmacist' });
    await updateUser(t.app, second.id, { isActive: false });
    // Switched-off users drop off the login screen and can't log in.
    expect((await listLoginUsers(t.ctx)).map((u) => u.name)).toEqual(['Owner']);
    await expect(login(t.ctx, { userId: second.id, pin: '975310' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const audits = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', second.id)
      .execute();
    expect(audits.map((a) => a.action)).toEqual([
      'user.create',
      'user.role_change',
      'user.deactivate',
    ]);
  });

  it('resets a forgotten PIN and lifts a lockout', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    for (let i = 0; i < 5; i++)
      await login(t.ctx, { userId: cashier.id, pin: '0000' }).catch(() => {});
    expect((await listUsers(t.app)).find((u) => u.id === cashier.id)?.lockedUntil).not.toBeNull();

    await unlockUser(t.app, cashier.id);
    await login(t.ctx, { userId: cashier.id, pin: cashier.pin });

    await resetUserPin(t.app, cashier.id, { pin: '5821', pinRepeat: '5821' });
    await expect(login(t.ctx, { userId: cashier.id, pin: cashier.pin })).rejects.toMatchObject({
      code: 'WRONG_PIN',
    });
    await login(t.ctx, { userId: cashier.id, pin: '5821' });
  });
});

describe('settings', () => {
  it('starts from the defaults and saves changes as synced rows', async () => {
    const t = await createTestApp();
    expect(await getStoreSettings(t.app)).toMatchObject({
      rounding: { step: 100, mode: 'nearest' },
      discountCapBp: { cashier: 500, pharmacist: 1500 },
    });
    const after = await updateStoreSettings(t.app, {
      rounding: { step: 100, mode: 'down' },
      defaultDiscountBp: 300,
    });
    expect(after.rounding.mode).toBe('down');
    expect(await getStoreSettings(t.app)).toMatchObject({ defaultDiscountBp: 300 });

    // Saving the same value again writes nothing.
    await updateStoreSettings(t.app, { defaultDiscountBp: 300 });
    const rows = await t.db.selectFrom('setting').select(['key']).execute();
    expect(rows.map((r) => r.key).sort()).toEqual(['defaultDiscountBp', 'rounding']);
    const outbox = await t.db
      .selectFrom('sync_outbox')
      .select('op')
      .where('table_name', '=', 'setting')
      .execute();
    expect(outbox).toHaveLength(2);
  });

  it('refuses caps below the default discount, and non-owners', async () => {
    const t = await createTestApp();
    await expect(updateStoreSettings(t.app, { defaultDiscountBp: 600 })).rejects.toMatchObject({
      code: 'VALIDATION',
      fields: { 'discountCapBp.cashier': expect.any(String) },
    });
    const pharmacist = await asRole(t, 'pharmacist');
    await expect(updateStoreSettings(pharmacist.app, { maxHeld: 5 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('falls back to the default when a stored value is bad', async () => {
    const t = await createTestApp();
    await updateStoreSettings(t.app, { maxHeld: 5 });
    await t.db.updateTable('setting').set({ value_json: '"lots"' }).execute();
    expect((await getStoreSettings(t.app)).maxHeld).toBe(10);
  });

  it('keeps printer settings on this till, off by default', async () => {
    const t = await createTestApp();
    expect(await getDeviceSettings(t.app)).toEqual(DEFAULT_DEVICE_SETTINGS);
    await expect(
      updateDeviceSettings(t.app, { printer: { mode: 'network' } }),
    ).rejects.toMatchObject({ fields: { 'printer.host': expect.any(String) } });
    await updateDeviceSettings(t.app, { printer: { mode: 'network', host: '192.168.1.50' } });
    expect((await getDeviceSettings(t.app)).printer).toMatchObject({
      mode: 'network',
      host: '192.168.1.50',
      port: 9100,
    });
  });
});
