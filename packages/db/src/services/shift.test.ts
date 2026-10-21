import { describe, expect, it } from 'vitest';
import { asRole, createTestApp, openTestShift } from '../test-helpers';
import { getClockStatus, resetClockGuard } from './clock';
import { updateStoreSettings } from './settings';
import {
  closeShift,
  getOpenShift,
  getShiftTotals,
  getSuggestedFloat,
  listShifts,
  openShift,
  recordCashMovement,
  recordNoSale,
} from './shift';

describe('opening a shift', () => {
  it('opens one shift per till and numbers them', async () => {
    const t = await createTestApp();
    expect(await getOpenShift(t.app)).toBeNull();
    expect(await getSuggestedFloat(t.app)).toBe(500_000);

    const shift = await openShift(t.app, {
      openingFloat: 500_000,
      count: { notes: { '100000': 4, '50000': 2 }, coins: 0 },
    });
    expect(shift).toMatchObject({
      shiftNo: 1,
      businessDate: '2026-10-21',
      openedBy: 'Owner',
      openingFloat: 500_000,
      stale: false,
    });
    await expect(openTestShift(t.app)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: 'Shift 1 is already open',
    });

    t.setNow('2026-10-22T04:00:00Z');
    expect((await getOpenShift(t.app))?.stale).toBe(true);
  });

  it('checks a note count against the float', async () => {
    const t = await createTestApp();
    await expect(
      openShift(t.app, { openingFloat: 500_000, count: { notes: { '100000': 4 }, coins: 0 } }),
    ).rejects.toMatchObject({ fields: { openingFloat: 'The notes add up to Rs 4,000.00' } });
  });

  it('asks to confirm the date when the clock is days ahead of the last record', async () => {
    const t = await createTestApp();
    await openTestShift(t.app);
    await closeShift(t.app, {
      shiftId: (await getOpenShift(t.app))!.id,
      countedCash: 500_000,
      floatLeft: 500_000,
    });
    t.setNow('2026-10-26T09:00:00Z');
    await expect(openTestShift(t.app)).rejects.toMatchObject({
      code: 'NEEDS_CONFIRMATION',
      details: { confirm: 'date', date: '2026-10-26' },
    });
    const shift = await openShift(t.app, { openingFloat: 500_000, confirmDate: '2026-10-26' });
    expect(shift.businessDate).toBe('2026-10-26');
  });

  it('refuses a date that can’t be right, and only warns when behind', async () => {
    const t = await createTestApp();
    t.setNow('2009-01-01T09:00:00Z');
    expect((await getClockStatus(t.app)).blocks).toBe(true);
    await expect(openTestShift(t.app)).rejects.toMatchObject({ code: 'CLOCK_WRONG' });

    t.setNow('2026-10-21T09:00:00Z');
    await openTestShift(t.app);
    t.setNow('2026-10-20T08:00:00Z');
    const status = await getClockStatus(t.app);
    expect(status).toMatchObject({ blocks: false, check: { status: 'behind' } });
    expect(status.message).toMatch(/behind the last record/);
    await recordCashMovement(t.app, { kind: 'pay_in', category: 'change', amount: 100, note: 'x' });
    await recordCashMovement(t.app, { kind: 'pay_in', category: 'change', amount: 100, note: 'y' });
    // Noted once for the shift, not on every document.
    const suspect = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'clock.suspect')
      .execute();
    expect(suspect).toHaveLength(1);
  });

  it('lets a pharmacist reset the clock guard after a forward jump', async () => {
    const t = await createTestApp();
    t.setNow('2026-10-24T09:00:00Z');
    await openShift(t.app, { openingFloat: 0, confirmDate: '2026-10-24' });
    t.setNow('2026-10-21T10:00:00Z');
    expect((await getClockStatus(t.app)).check.status).toBe('behind');
    const cashier = await asRole(t, 'cashier');
    const pharmacist = await asRole(t, 'pharmacist');
    await expect(resetClockGuard(cashier.app)).rejects.toMatchObject({ code: 'NEEDS_APPROVAL' });
    await resetClockGuard(cashier.app, {
      approval: { userId: pharmacist.id, pin: pharmacist.pin },
    });
    expect((await getClockStatus(t.app)).check.status).toBe('ok');
  });
});

describe('cash in and out', () => {
  it('keeps expected cash from the records', async () => {
    const t = await createTestApp();
    const shift = await openTestShift(t.app);
    await recordCashMovement(t.app, {
      kind: 'pay_in',
      category: 'change',
      amount: 50_000,
      note: 'Change from bank',
    });
    expect(
      await recordCashMovement(t.app, {
        kind: 'pay_out',
        category: 'expense',
        amount: 15_000,
        note: 'Tea',
      }),
    ).toMatchObject({ openDrawer: true });
    const totals = await getShiftTotals(t.app, shift.id);
    expect(totals).toMatchObject({
      cashIn: 50_000,
      cashOut: 15_000,
      cashByCategory: { change: 50_000, expense: -15_000 },
      expectedCash: 535_000,
    });
  });

  it('needs a pharmacist for a large pay-out, and never pays out more than the drawer', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const pharmacist = await asRole(t, 'pharmacist');
    await openTestShift(cashier.app, 300_000);
    const payOut = (amount: number, approval?: { userId: string; pin: string }) =>
      recordCashMovement(cashier.app, {
        kind: 'pay_out',
        category: 'supplier',
        amount,
        note: 'Distributor',
        approval,
      });

    await expect(payOut(250_000)).rejects.toMatchObject({
      code: 'NEEDS_APPROVAL',
      details: { permission: 'cash.pay_out_large' },
    });
    const approval = { userId: pharmacist.id, pin: pharmacist.pin };
    // The cashier counts blind, so the message doesn't give the drawer's total.
    await expect(payOut(350_000, approval)).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'There isn’t that much cash in the drawer',
    });
    await payOut(250_000, approval);
    const row = await t.db.selectFrom('cash_movement').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      amount: -250_000,
      user_id: cashier.id,
      approved_by: pharmacist.id,
    });
    // A pharmacist sees the figure.
    await expect(
      recordCashMovement(pharmacist.app, {
        kind: 'pay_out',
        category: 'expense',
        amount: 60_000,
        note: 'x',
      }),
    ).rejects.toMatchObject({ message: 'Only Rs 500.00 should be in the drawer' });
  });

  it('needs an open shift, and logs a no-sale drawer opening', async () => {
    const t = await createTestApp();
    await expect(
      recordCashMovement(t.app, { kind: 'pay_in', category: 'change', amount: 100, note: 'x' }),
    ).rejects.toMatchObject({ code: 'NO_SHIFT' });
    await openTestShift(t.app);
    await recordNoSale(t.app, { reason: 'Change for Rs 5,000 note' });
    const audit = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'drawer.no_sale')
      .executeTakeFirstOrThrow();
    expect(audit.reason).toBe('Change for Rs 5,000 note');
  });
});

describe('closing a shift', () => {
  it('closes with a blind count, asks for a note on a big difference, and logs the first count', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const shift = await openTestShift(cashier.app);
    await recordCashMovement(cashier.app, {
      kind: 'pay_out',
      category: 'expense',
      amount: 15_000,
      note: 'Tea',
    });
    // Counting blind: no expected figure before closing.
    expect((await getShiftTotals(cashier.app, shift.id)).expectedCash).toBeNull();

    const first = await closeShift(cashier.app, {
      shiftId: shift.id,
      countedCash: 470_000,
      floatLeft: 400_000,
    });
    expect(first).toEqual({ status: 'needs_note', variance: -15_000 });
    const counts = await t.db
      .selectFrom('audit_log')
      .select('after_json')
      .where('action', '=', 'shift.count')
      .execute();
    expect(JSON.parse(counts[0]!.after_json!)).toEqual({
      counted: 470_000,
      expected: 485_000,
      variance: -15_000,
    });
    expect(await getOpenShift(cashier.app)).not.toBeNull();

    const closed = await closeShift(cashier.app, {
      shiftId: shift.id,
      countedCash: 470_000,
      floatLeft: 400_000,
      note: 'Gave change twice by mistake',
    });
    expect(closed.status).toBe('closed');
    expect(closed.status === 'closed' && closed.totals).toMatchObject({
      shift: { status: 'closed', countedCash: 470_000, variance: -15_000, floatLeft: 400_000 },
      expectedCash: 485_000,
      cashOut: 15_000,
    });
    expect(await getOpenShift(cashier.app)).toBeNull();
    expect(await getSuggestedFloat(cashier.app)).toBe(400_000);
    expect((await listShifts(cashier.app))[0]).toMatchObject({ shiftNo: 1, variance: null });
    expect((await listShifts(t.app))[0]).toMatchObject({ variance: -15_000 });

    // Opening with a different float than was left is allowed but noted.
    await openTestShift(cashier.app, 450_000);
    const mismatch = await t.db
      .selectFrom('audit_log')
      .select('action')
      .where('action', '=', 'shift.float_mismatch')
      .execute();
    expect(mismatch).toHaveLength(1);
  });

  it('refuses to leave more than was counted, or to close with a sale in progress', async () => {
    const t = await createTestApp();
    const shift = await openTestShift(t.app);
    await expect(
      closeShift(t.app, { shiftId: shift.id, countedCash: 500_000, floatLeft: 600_000 }),
    ).rejects.toMatchObject({ fields: { floatLeft: expect.any(String) } });

    const at = '2026-10-21T09:00:00.000Z';
    await t.db
      .insertInto('sale_draft')
      .values({
        id: 'd1',
        device_id: t.app.session.deviceId,
        user_id: t.app.session.userId,
        status: 'active',
        label: null,
        cart_json: '{}',
        line_count: 2,
        total: 1000,
        created_at: at,
        updated_at: at,
        held_at: null,
      })
      .execute();
    await expect(
      closeShift(t.app, { shiftId: shift.id, countedCash: 500_000, floatLeft: 500_000 }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('uses the store’s note threshold', async () => {
    const t = await createTestApp();
    await updateStoreSettings(t.app, { varianceNoteAt: 50_000 });
    const shift = await openTestShift(t.app);
    const result = await closeShift(t.app, {
      shiftId: shift.id,
      countedCash: 480_000,
      floatLeft: 0,
    });
    expect(result.status).toBe('closed');
  });
});
