import { describe, expect, it } from 'vitest';
import { asRole, checkout, openTestShift, ringUp, workedStore } from '../test-helpers';
import { getLastReceipt, getReceiptNotice, recordDrawerTest, setReceiptStatus } from './printing';
import { planReturn, createReturn } from './returns';
import { getSale, voidSale } from './sales';
import { updateDeviceSettings } from './settings';

async function printingOn(autoPrint = true) {
  const s = await workedStore();
  await updateDeviceSettings(s.app, {
    printer: { mode: 'network', host: '127.0.0.1', port: 9100, autoPrint },
    drawer: { enabled: true, pin: 2 },
  });
  await openTestShift(s.app);
  return s;
}

async function sellPanadol(s: Awaited<ReturnType<typeof workedStore>>) {
  return checkout(s.app, await ringUp(s.app, [{ productId: s.panadol.id, unit: 'Strip', qty: 1 }]));
}

describe('last receipt', () => {
  it('is not written while printing is off (the default)', async () => {
    const s = await workedStore();
    await openTestShift(s.app);
    await sellPanadol(s);
    expect(await getLastReceipt(s.app)).toBeNull();
    expect(await getReceiptNotice(s.app)).toBeNull();
  });

  it('is not written when receipts print only on request', async () => {
    const s = await printingOn(false);
    await sellPanadol(s);
    expect(await getLastReceipt(s.app)).toBeNull();
  });

  it('is pending after a sale until the printer answers', async () => {
    const s = await printingOn();
    const sale = await sellPanadol(s);
    const ref = { docType: 'sale' as const, docId: sale.saleId };
    expect(await getLastReceipt(s.app)).toEqual({ ...ref, status: 'pending' });
    // A power cut now: at the next start the till asks about T1-000001.
    expect(await getReceiptNotice(s.app)).toEqual({
      ...ref,
      status: 'pending',
      number: 'T1-000001',
      saleId: sale.saleId,
    });

    await setReceiptStatus(s.app, ref, 'failed');
    expect(await getReceiptNotice(s.app)).toMatchObject({ status: 'failed', number: 'T1-000001' });
    await setReceiptStatus(s.app, ref, 'done');
    expect(await getLastReceipt(s.app)).toEqual({ ...ref, status: 'done' });
    expect(await getReceiptNotice(s.app)).toBeNull();
  });

  it('is skipped when staff choose not to print it', async () => {
    const s = await printingOn();
    const sale = await sellPanadol(s);
    await setReceiptStatus(s.app, { docType: 'sale', docId: sale.saleId }, 'skipped');
    expect(await getReceiptNotice(s.app)).toBeNull();
  });

  it('keeps a newer receipt when an older one answers late', async () => {
    const s = await printingOn();
    const first = await sellPanadol(s);
    const second = await sellPanadol(s);
    await setReceiptStatus(s.app, { docType: 'sale', docId: first.saleId }, 'done');
    expect(await getReceiptNotice(s.app)).toMatchObject({
      docId: second.saleId,
      status: 'pending',
      number: 'T1-000002',
    });
  });

  it('names the voided sale for a void, and the return number for a return', async () => {
    const s = await printingOn();
    const voided = await sellPanadol(s);
    const v = await voidSale(s.app, { saleId: voided.saleId, reason: 'Rang up twice' });
    expect(await getReceiptNotice(s.app)).toEqual({
      docType: 'void',
      docId: v.voidId,
      status: 'pending',
      number: 'T1-000001',
      saleId: voided.saleId,
    });

    const kept = await sellPanadol(s);
    const line = (await getSale(s.app, kept.saleId))!.lines[0]!.id;
    const lines = [{ saleLineId: line, qty: 10, restock: true }];
    const plan = await planReturn(s.app, { saleId: kept.saleId, lines });
    const ret = await createReturn(s.app, {
      saleId: kept.saleId,
      lines,
      reason: 'doctor_changed',
      refunds: plan.suggestedRefunds,
      expectedRefund: plan.refundTotal,
    });
    expect(await getReceiptNotice(s.app)).toEqual({
      docType: 'return',
      docId: ret.returnId,
      status: 'pending',
      number: ret.returnNo,
      saleId: kept.saleId,
    });
  });
});

describe('recordDrawerTest', () => {
  it('logs a drawer test by the owner and refuses a cashier', async () => {
    const s = await workedStore();
    await recordDrawerTest(s.app, { pin: 5 });
    const row = await s.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'drawer.test')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(row.after_json!)).toEqual({ pin: 5 });

    const cashier = await asRole(s, 'cashier');
    await expect(recordDrawerTest(cashier.app, { pin: 2 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
