import { DEFAULT_DEVICE_SETTINGS, type AppContext, type DeviceSettings } from '@app/db';
import type * as DbModule from '@app/db';
import type { ReceiptDocument } from '@app/receipt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrintTarget, PrinterPort } from '../../platform/printer';
import { PrintJobs } from './print-jobs';
import { createPrinting } from './printing';

const db = vi.hoisted(() => ({
  setReceiptStatus: vi.fn(async () => {}),
  recordDrawerTest: vi.fn(async () => {}),
}));
vi.mock('@app/db', async (importOriginal) => ({
  ...(await importOriginal<typeof DbModule>()),
  ...db,
}));

const ctx = {} as AppContext;
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

const doc: ReceiptDocument = {
  width: 48,
  lines: [{ kind: 'text', text: 'TOTAL Rs 100.00', bold: true }],
  cut: true,
  drawer: null,
};

function device(
  printer: Partial<DeviceSettings['printer']> = {},
  drawer: Partial<DeviceSettings['drawer']> = {},
): DeviceSettings {
  return {
    ...DEFAULT_DEVICE_SETTINGS,
    printer: { ...DEFAULT_DEVICE_SETTINGS.printer, ...printer },
    drawer: { ...DEFAULT_DEVICE_SETTINGS.drawer, ...drawer },
  };
}

const networkWithDrawer = (autoPrint = true) =>
  device({ mode: 'network', host: '127.0.0.1', port: 9100, autoPrint }, { enabled: true, pin: 2 });

function setUp(fail = false) {
  const sent: { target: PrintTarget; bytes: Uint8Array }[] = [];
  const port: PrinterPort = {
    printRaw: async (target, bytes) => {
      if (fail) throw 'Printer not reachable at 127.0.0.1:9100';
      sent.push({ target, bytes });
    },
    listPrinters: async () => [],
  };
  const jobs = new PrintJobs();
  return { sent, jobs, printing: createPrinting(ctx, port, jobs) };
}

const sale = { docType: 'sale' as const, docId: 'sale-1' };

beforeEach(() => {
  db.setReceiptStatus.mockClear();
  db.recordDrawerTest.mockClear();
});

describe('afterDocument', () => {
  it('prints nothing while printing is off, and says to open the drawer by hand', async () => {
    const { sent, jobs, printing } = setUp();
    const out = printing.afterDocument({
      doc,
      settings: device({}, { enabled: true }),
      cashMoved: true,
      ref: sale,
      title: 'Receipt T1-000001',
    });
    expect(out).toMatchObject({ receiptJob: null, drawerJob: null, plan: { openByHand: true } });
    await jobs.idle();
    expect(sent).toEqual([]);
    expect(db.setReceiptStatus).not.toHaveBeenCalled();
  });

  it('prints a cash sale with the drawer pulse inside, and records it as printed', async () => {
    const { sent, jobs, printing } = setUp();
    const out = printing.afterDocument({
      doc,
      settings: networkWithDrawer(),
      cashMoved: true,
      ref: sale,
      title: 'Receipt T1-000001',
    });
    expect(out.receiptJob).not.toBeNull();
    expect(out.drawerJob).toBeNull();
    await jobs.idle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toEqual({ mode: 'network', host: '127.0.0.1', port: 9100 });
    expect(hex(sent[0]!.bytes).startsWith('1B 40 1B 70 00 19 FA 1B 74 00')).toBe(true);
    expect(db.setReceiptStatus).toHaveBeenCalledWith(ctx, sale, 'done');
  });

  it('opens the drawer on its own when receipts print only on request', async () => {
    const { sent, jobs, printing } = setUp();
    const out = printing.afterDocument({
      doc,
      settings: networkWithDrawer(false),
      cashMoved: true,
      ref: null,
      title: 'Receipt T1-000001',
    });
    expect(out.receiptJob).toBeNull();
    expect(out.drawerJob).not.toBeNull();
    await jobs.idle();
    expect(sent.map((s) => hex(s.bytes))).toEqual(['1B 40 1B 70 00 19 FA']);
  });

  it('still opens the drawer when the receipt could not be built', async () => {
    const { sent, jobs, printing } = setUp();
    printing.afterDocument({
      doc: null,
      settings: networkWithDrawer(),
      cashMoved: true,
      ref: sale,
      title: 'Receipt T1-000001',
    });
    await jobs.idle();
    expect(sent.map((s) => hex(s.bytes))).toEqual(['1B 40 1B 70 00 19 FA']);
  });

  it('records a failed receipt, and Show on screen as skipped', async () => {
    const { jobs, printing } = setUp(true);
    const out = printing.afterDocument({
      doc,
      settings: networkWithDrawer(),
      cashMoved: false,
      ref: sale,
      title: 'Receipt T1-000001',
    });
    await jobs.idle();
    expect(jobs.get(out.receiptJob!)).toMatchObject({
      status: 'failed',
      error: 'Printer not reachable at 127.0.0.1:9100',
    });
    expect(db.setReceiptStatus).toHaveBeenLastCalledWith(ctx, sale, 'failed');
    jobs.settle(out.receiptJob!);
    await vi.waitFor(() =>
      expect(db.setReceiptStatus).toHaveBeenLastCalledWith(ctx, sale, 'skipped'),
    );
  });
});

describe('reprints and tests', () => {
  it('reprints without opening the drawer', async () => {
    const { sent, jobs, printing } = setUp();
    const out = printing.reprint(doc, networkWithDrawer(false), 'Receipt T1-000001');
    expect(out.receiptJob).not.toBeNull();
    await jobs.idle();
    expect(hex(sent[0]!.bytes)).not.toContain('1B 70');
    expect(db.setReceiptStatus).not.toHaveBeenCalled();
  });

  it('logs a drawer test, then opens the drawer on the chosen pin', async () => {
    const { sent, jobs, printing } = setUp();
    await printing.testDrawer(device({ mode: 'network', host: '127.0.0.1' }, { pin: 5 }));
    expect(db.recordDrawerTest).toHaveBeenCalledWith(ctx, { pin: 5 });
    await jobs.idle();
    expect(sent.map((s) => hex(s.bytes))).toEqual(['1B 40 1B 70 01 19 FA']);
  });

  it('tests nothing while printing is off', async () => {
    const { printing } = setUp();
    expect(await printing.testDrawer(device())).toBeNull();
    expect(printing.printTest(doc, device())).toBeNull();
    expect(db.recordDrawerTest).not.toHaveBeenCalled();
  });
});
