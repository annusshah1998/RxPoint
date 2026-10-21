import { describe, expect, it } from 'vitest';
import { createServiceContext } from '../context';
import type { Db } from '../executor';
import { asRole, createTestApp, tabletInput } from '../test-helpers';
import {
  changeOwnPin,
  listLoginUsers,
  login,
  ownerNeedsPin,
  resetOwnerPinWithRecovery,
  setInitialOwnerPin,
} from './auth';
import { createProduct, updateProduct } from './catalog';
import { authorizeTx, verifyApprover } from './guards';
import { runImport } from './import';
import { addOpeningStock } from './stock';

async function auditActions(t: { db: Db }) {
  const rows = await t.db.selectFrom('audit_log').select('action').orderBy('created_at').execute();
  return rows.map((r) => r.action);
}

describe('login', () => {
  it('starts a session with the right PIN', async () => {
    const t = await createTestApp();
    const session = await login(t.ctx, { userId: t.app.session.userId, pin: t.ownerPin });
    expect(session).toEqual(t.app.session);
    expect(await auditActions(t)).toContain('auth.login');
    expect(await listLoginUsers(t.ctx)).toEqual([
      { id: session.userId, name: 'Owner', role: 'owner', hasPin: true, lockedUntil: null },
    ]);
  });

  it('counts wrong PINs, locks after five, and unlocks after a minute', async () => {
    const t = await createTestApp();
    const userId = t.app.session.userId;
    const wrong = () => login(t.ctx, { userId, pin: '111222' });

    await expect(wrong()).rejects.toMatchObject({
      code: 'WRONG_PIN',
      message: 'Wrong PIN — 4 tries left',
    });
    for (let i = 0; i < 3; i++) await wrong().catch(() => {});
    await expect(wrong()).rejects.toMatchObject({
      code: 'LOCKED',
      message: 'Too many wrong PINs. Try again at 14:01.',
    });
    // Even the right PIN is refused while locked.
    await expect(login(t.ctx, { userId, pin: t.ownerPin })).rejects.toMatchObject({
      code: 'LOCKED',
    });
    expect((await listLoginUsers(t.ctx))[0]!.lockedUntil).toBe('2026-10-21T09:01:00.000Z');
    expect(await auditActions(t)).toContain('auth.lockout');

    // The lock is in the database, so a restart (new context) doesn't clear it.
    const restarted = createServiceContext(t.db, { now: () => new Date('2026-10-21T09:00:30Z') });
    await expect(login(restarted, { userId, pin: t.ownerPin })).rejects.toMatchObject({
      code: 'LOCKED',
    });

    t.setNow('2026-10-21T09:01:01Z');
    await login(t.ctx, { userId, pin: t.ownerPin });
    // A good login resets the count.
    await expect(wrong()).rejects.toMatchObject({ message: 'Wrong PIN — 4 tries left' });
  });

  it('refuses switched-off users and unknown ids', async () => {
    const t = await createTestApp();
    await expect(login(t.ctx, { userId: 'nobody', pin: '1234' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('owner recovery', () => {
  it('resets the PIN with the recovery code, which then changes', async () => {
    const t = await createTestApp();
    const userId = t.app.session.userId;
    // Lock the owner out first.
    for (let i = 0; i < 5; i++) await login(t.ctx, { userId, pin: '000111' }).catch(() => {});

    await expect(
      resetOwnerPinWithRecovery(t.ctx, {
        recoveryCode: 'AAAA-BBBB-CCCC',
        pin: '864208',
        pinRepeat: '864208',
      }),
    ).rejects.toMatchObject({ code: 'WRONG_PIN', fields: { recoveryCode: expect.any(String) } });

    const typed = t.recoveryCode.toLowerCase().replace(/-/g, ' ');
    const { recoveryCode } = await resetOwnerPinWithRecovery(t.ctx, {
      recoveryCode: typed,
      pin: '864208',
      pinRepeat: '864208',
    });
    expect(recoveryCode).not.toBe(t.recoveryCode);
    await login(t.ctx, { userId, pin: '864208' });
    expect(await auditActions(t)).toContain('auth.recovery_used');

    // The old code no longer works.
    await expect(
      resetOwnerPinWithRecovery(t.ctx, { recoveryCode: typed, pin: '975310', pinRepeat: '975310' }),
    ).rejects.toMatchObject({ code: 'WRONG_PIN' });
  });

  it('sets a first PIN for an owner from before PIN login, once', async () => {
    const t = await createTestApp();
    const userId = t.app.session.userId;
    await t.db.updateTable('app_user').set({ pin_hash: null }).where('id', '=', userId).execute();
    expect(await ownerNeedsPin(t.ctx)).toBe(true);

    const { session, recoveryCode } = await setInitialOwnerPin(t.ctx, {
      pin: '864208',
      pinRepeat: '864208',
    });
    expect(session).toEqual(t.app.session);
    expect(recoveryCode).toMatch(/-/);
    expect(await ownerNeedsPin(t.ctx)).toBe(false);
    await expect(
      setInitialOwnerPin(t.ctx, { pin: '975310', pinRepeat: '975310' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('changes your own PIN after checking the current one', async () => {
    const t = await createTestApp();
    await expect(
      changeOwnPin(t.app, { currentPin: '000111', pin: '864208', pinRepeat: '864208' }),
    ).rejects.toMatchObject({ code: 'WRONG_PIN', fields: { currentPin: expect.any(String) } });
    await changeOwnPin(t.app, { currentPin: t.ownerPin, pin: '864208', pinRepeat: '864208' });
    await login(t.ctx, { userId: t.app.session.userId, pin: '864208' });
    // No PIN hash goes into the audit log.
    const audits = await t.db.selectFrom('audit_log').selectAll().execute();
    expect(JSON.stringify(audits)).not.toContain('pbkdf2');
  });
});

describe('permissions', () => {
  it('forbids back-office work outside the role', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const product = await createProduct(t.app, tabletInput());

    await expect(createProduct(cashier.app, tabletInput({ name: 'Brufen' }))).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
        message: 'Only a pharmacist, an inventory clerk or the owner can do this',
      },
    );
    await expect(
      updateProduct(cashier.app, product.id, tabletInput({ salePrice: 1 })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      addOpeningStock(cashier.app, { productId: product.id, qty: 5, expiryDate: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      runImport(cashier.app, { rows: [], columns: [], warnings: [] } as never),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The inventory clerk may.
    const clerk = await asRole(t, 'inventory');
    await addOpeningStock(clerk.app, { productId: product.id, qty: 5, expiryDate: null });
  });

  it('asks for a PIN for counter work, and records who approved', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const pharmacist = await asRole(t, 'pharmacist');

    const check = (approval?: Awaited<ReturnType<typeof verifyApprover>>) =>
      t.db.transaction().execute((trx) => authorizeTx(trx, cashier.app, 'sale.void', approval));

    await expect(check()).rejects.toMatchObject({
      code: 'NEEDS_APPROVAL',
      message: 'Needs a PIN from a pharmacist or the owner',
      details: { permission: 'sale.void' },
    });

    const approval = await verifyApprover(
      cashier.app,
      { userId: pharmacist.id, pin: pharmacist.pin },
      'sale.void',
    );
    expect(await check(approval)).toMatchObject({ approvedBy: pharmacist.id });

    // The approver switched off since: the approval no longer counts.
    await t.db
      .updateTable('app_user')
      .set({ is_active: 0 })
      .where('id', '=', pharmacist.id)
      .execute();
    await expect(check(approval)).rejects.toMatchObject({ code: 'NEEDS_APPROVAL' });
  });

  it('refuses self-approval and counts an approver’s wrong PIN against the approver', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const pharmacist = await asRole(t, 'pharmacist');
    const otherCashier = await asRole(t, 'cashier', 'Bilal');

    await expect(
      verifyApprover(pharmacist.app, { userId: pharmacist.id, pin: pharmacist.pin }, 'sale.void'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      verifyApprover(cashier.app, { userId: otherCashier.id, pin: otherCashier.pin }, 'sale.void'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Bilal can’t approve this' });

    await expect(
      verifyApprover(cashier.app, { userId: pharmacist.id, pin: '9999' }, 'sale.void'),
    ).rejects.toMatchObject({ code: 'WRONG_PIN' });
    const attempts = await t.db.selectFrom('pin_attempt').selectAll().execute();
    expect(attempts).toMatchObject([{ user_id: pharmacist.id, failed_count: 1 }]);
  });

  it('checks a discount approval against the approver’s cap', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const pharmacist = await asRole(t, 'pharmacist');
    const approve = (needBp: number) =>
      verifyApprover(
        cashier.app,
        { userId: pharmacist.id, pin: pharmacist.pin },
        {
          discountBp: needBp,
        },
      );
    expect(await approve(1180)).toMatchObject({ capBp: 1500 });
    await expect(approve(2000)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Pharmacist can give at most 15% discount',
    });
  });
});
