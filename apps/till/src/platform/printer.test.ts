import { DEFAULT_DEVICE_SETTINGS } from '@app/db';
import { ESCPOS, decodeEscPos, renderText, type ReceiptDocument } from '@app/receipt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEV_PRINT_PATH,
  createPrinterPort,
  drawerBytes,
  printPlan,
  printTarget,
  receiptBytes,
  sendJob,
  type PrintTarget,
  type PrinterPort,
  type PrinterSettings,
} from './printer';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => false }));

function settings(
  printer: Partial<PrinterSettings['printer']> = {},
  drawer: Partial<PrinterSettings['drawer']> = {},
): PrinterSettings {
  return {
    printer: { ...DEFAULT_DEVICE_SETTINGS.printer, ...printer },
    drawer: { ...DEFAULT_DEVICE_SETTINGS.drawer, ...drawer },
  };
}

const network = (drawer: Partial<PrinterSettings['drawer']> = {}, autoPrint = true) =>
  settings({ mode: 'network', host: ' 192.168.1.50 ', port: 9100, autoPrint }, drawer);

const doc: ReceiptDocument = {
  width: 48,
  lines: [
    { kind: 'text', text: 'Shifa Pharmacy', align: 'center', bold: true, large: true },
    { kind: 'pair', left: 'Invoice T1-000123', right: '21-10-2026 14:05' },
    { kind: 'rule' },
    { kind: 'text', text: 'TOTAL Rs 1,965.00', bold: true, large: true },
    { kind: 'barcode', data: 'T1-000123' },
  ],
  cut: true,
  drawer: null,
};

const hex = (bytes: Uint8Array | readonly number[]) =>
  Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** A port that records what it was asked to print. */
function recordingPort(fail?: unknown) {
  const jobs: { target: PrintTarget; bytes: Uint8Array }[] = [];
  const port: PrinterPort = {
    printRaw: async (target, bytes) => {
      if (fail !== undefined) throw fail;
      jobs.push({ target, bytes });
    },
    listPrinters: async () => [],
  };
  return { port, jobs };
}

describe('printTarget', () => {
  it('is null while printing is off (the default)', () => {
    expect(printTarget(DEFAULT_DEVICE_SETTINGS)).toBeNull();
  });

  it('sends Windows jobs to the named printer, or the default when none is named', () => {
    expect(printTarget(settings({ mode: 'windows', printerName: 'EPSON TM-T20' }))).toEqual({
      mode: 'windows',
      printerName: 'EPSON TM-T20',
    });
    expect(printTarget(settings({ mode: 'windows', printerName: '  ' }))).toEqual({
      mode: 'windows',
      printerName: null,
    });
  });

  it('sends network jobs to the IP address and port', () => {
    expect(printTarget(network())).toEqual({ mode: 'network', host: '192.168.1.50', port: 9100 });
  });
});

describe('printPlan', () => {
  it('only says "open the drawer by hand" while printing is off', () => {
    const off = settings({}, { enabled: true });
    expect(printPlan(off, { cashMoved: true })).toEqual({
      printReceipt: false,
      drawerInReceipt: false,
      drawerAlone: false,
      openByHand: true,
    });
    expect(printPlan(off, { cashMoved: false }).openByHand).toBe(false);
  });

  it('puts the pulse inside the receipt when one prints', () => {
    expect(printPlan(network({ enabled: true }), { cashMoved: true })).toEqual({
      printReceipt: true,
      drawerInReceipt: true,
      drawerAlone: false,
      openByHand: false,
    });
  });

  it('sends the pulse on its own when receipts print only on request', () => {
    expect(printPlan(network({ enabled: true }, false), { cashMoved: true })).toEqual({
      printReceipt: false,
      drawerInReceipt: false,
      drawerAlone: true,
      openByHand: false,
    });
  });

  it('prints without the drawer when no cash moved, or no drawer is set up', () => {
    expect(printPlan(network({ enabled: true }), { cashMoved: false })).toMatchObject({
      printReceipt: true,
      drawerInReceipt: false,
      drawerAlone: false,
      openByHand: false,
    });
    expect(printPlan(network({ enabled: false }), { cashMoved: true })).toMatchObject({
      printReceipt: true,
      drawerInReceipt: false,
      openByHand: true,
    });
  });
});

describe('the bytes', () => {
  it('open the drawer right after init, before the receipt prints', () => {
    const bytes = receiptBytes(doc, network({ enabled: true, pin: 2 }), { openDrawer: true });
    expect(hex(bytes.slice(0, 7))).toBe('1B 40 1B 70 00 19 FA');
    // Then the code page and the receipt; the pulse appears once only.
    expect(hex(bytes.slice(7, 10))).toBe(hex(ESCPOS.codePage437));
    expect(hex(bytes).split('1B 70').length).toBe(2);
  });

  it('use pin 5 when set, and no pulse when the drawer is off or not wanted', () => {
    const pin5 = receiptBytes(doc, network({ enabled: true, pin: 5 }), { openDrawer: true });
    expect(hex(pin5.slice(0, 7))).toBe('1B 40 1B 70 01 19 FA');
    const disabled = receiptBytes(doc, network({ enabled: false }), { openDrawer: true });
    expect(hex(disabled)).not.toContain('1B 70');
    const noCash = receiptBytes(doc, network({ enabled: true }), { openDrawer: false });
    expect(hex(noCash)).not.toContain('1B 70');
  });

  it('cut the paper as set', () => {
    const cut = hex(ESCPOS.feedAndCut);
    expect(hex(receiptBytes(doc, network(), { openDrawer: false })).endsWith(cut)).toBe(true);
    const noCut = settings({ mode: 'network', host: 'x', cut: false });
    expect(hex(receiptBytes(doc, noCut, { openDrawer: false }))).not.toContain('1D 56');
  });

  it('print what the preview shows', () => {
    const bytes = receiptBytes(doc, network({ enabled: true }), { openDrawer: true });
    // The printer isn't sent trailing spaces.
    const trim = (lines: string[]) => lines.map((l) => l.trimEnd());
    expect(trim(decodeEscPos(bytes, 48))).toEqual(trim(renderText(doc)));
  });

  it('open just the drawer: init and the pulse, nothing else', () => {
    expect(hex(drawerBytes(network({ pin: 2 })))).toBe('1B 40 1B 70 00 19 FA');
    expect(hex(drawerBytes(network({ pin: 5 })))).toBe('1B 40 1B 70 01 19 FA');
  });
});

describe('sendJob', () => {
  it('sends nothing while printing is off', async () => {
    const { port, jobs } = recordingPort();
    expect(await sendJob(port, DEFAULT_DEVICE_SETTINGS, drawerBytes(network()))).toEqual({
      ok: false,
      message: 'Printing is off',
    });
    expect(jobs).toEqual([]);
  });

  it('sends the bytes to the target', async () => {
    const { port, jobs } = recordingPort();
    const bytes = drawerBytes(network());
    expect(await sendJob(port, network(), bytes)).toEqual({ ok: true });
    expect(jobs).toEqual([
      { target: { mode: 'network', host: '192.168.1.50', port: 9100 }, bytes },
    ]);
  });

  it('turns a failure into a message instead of throwing', async () => {
    // Rust returns errors as plain strings.
    const rust = recordingPort('Printer not reachable at 192.168.1.50:9100');
    expect(await sendJob(rust.port, network(), new Uint8Array([1]))).toEqual({
      ok: false,
      message: 'Printer not reachable at 192.168.1.50:9100',
    });
    const js = recordingPort(new Error('Failed to fetch'));
    expect(await sendJob(js.port, network(), new Uint8Array([1]))).toEqual({
      ok: false,
      message: 'Failed to fetch',
    });
  });
});

describe('createPrinterPort', () => {
  afterEach(() => {
    invoke.mockReset();
    vi.unstubAllGlobals();
  });

  it('desktop: sends print_raw the target and the bytes as numbers', async () => {
    invoke.mockResolvedValue(undefined);
    const port = createPrinterPort('desktop');
    const target: PrintTarget = { mode: 'windows', printerName: null };
    await port.printRaw(target, new Uint8Array([0x1b, 0x40]));
    // Tauri sends arguments as JSON; Rust's Vec<u8> needs an array, not a typed array.
    expect(invoke).toHaveBeenCalledWith('print_raw', { target, bytes: [0x1b, 0x40] });
  });

  it('desktop: lists the Windows printers', async () => {
    invoke.mockResolvedValue([{ name: 'POS-80', isDefault: true }]);
    expect(await createPrinterPort('desktop').listPrinters()).toEqual([
      { name: 'POS-80', isDefault: true },
    ]);
    expect(invoke).toHaveBeenCalledWith('printer_list');
  });

  it('browser preview: network jobs go through the dev server; Windows ones are refused', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const port = createPrinterPort('browser');
    await port.printRaw({ mode: 'network', host: '127.0.0.1', port: 9100 }, new Uint8Array([1, 2]));
    expect(fetch).toHaveBeenCalledWith(
      DEV_PRINT_PATH,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-printer-host': '127.0.0.1',
          'x-printer-port': '9100',
        }),
      }),
    );
    await expect(
      port.printRaw({ mode: 'windows', printerName: null }, new Uint8Array([1])),
    ).rejects.toThrow(/desktop app/);
  });

  it('browser preview: passes on the dev server’s message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Printer not reachable at 127.0.0.1:9', { status: 502 })),
    );
    await expect(
      createPrinterPort('browser').printRaw(
        { mode: 'network', host: '127.0.0.1', port: 9 },
        new Uint8Array([1]),
      ),
    ).rejects.toThrow('Printer not reachable at 127.0.0.1:9');
  });
});
