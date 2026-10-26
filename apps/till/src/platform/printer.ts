import type { DeviceSettings } from '@app/db';
import { drawerKick, renderEscPos, type ReceiptDocument } from '@app/receipt';
import { invoke } from '@tauri-apps/api/core';
import { S } from '../strings';
import type { Platform } from './index';

/**
 * Receipt printing and the cash drawer (docs/m2-design.md §6.4).
 *
 * The bytes are built here from the same receipt document the screen shows; the desktop
 * app's Rust side (src-tauri/src/printer.rs) only delivers them. Printing never decides
 * whether a sale happened: callers print after their transaction has committed, and a
 * failure is reported, never thrown at the sale.
 */

/** Where a job goes: the shape `print_raw` takes. */
export type PrintTarget =
  { mode: 'windows'; printerName: string | null } | { mode: 'network'; host: string; port: number };

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
}

/** Delivers ready-made ESC/POS bytes to a printer. */
export interface PrinterPort {
  /** Resolves once the printer (or the Windows spooler) has taken the job. */
  printRaw(target: PrintTarget, bytes: Uint8Array): Promise<void>;
  listPrinters(): Promise<PrinterInfo[]>;
}

export type PrinterSettings = Pick<DeviceSettings, 'printer' | 'drawer'>;

/** Where this till's jobs go, or null when printing is off. */
export function printTarget(settings: PrinterSettings): PrintTarget | null {
  const p = settings.printer;
  switch (p.mode) {
    case 'off':
      return null;
    case 'windows':
      return { mode: 'windows', printerName: p.printerName?.trim() || null };
    case 'network':
      return { mode: 'network', host: p.host.trim(), port: p.port };
  }
}

/** The drawer opens through the printer, so it needs both. */
export function drawerWorks(settings: PrinterSettings): boolean {
  return settings.printer.mode !== 'off' && settings.drawer.enabled;
}

/** What happens after a document that may have moved cash (a sale, void or return). */
export interface PrintPlan {
  /** Print the receipt now (printing is on with auto-print). */
  printReceipt: boolean;
  /** The drawer pulse goes inside that receipt, right after init. */
  drawerInReceipt: boolean;
  /** No receipt is printing, so the pulse goes on its own (`drawerKick`). */
  drawerAlone: boolean;
  /** Cash moved but the drawer can't be opened from here: tell staff to open it by hand. */
  openByHand: boolean;
}

export function printPlan(
  settings: PrinterSettings,
  { cashMoved }: { cashMoved: boolean },
): PrintPlan {
  const printReceipt = settings.printer.mode !== 'off' && settings.printer.autoPrint;
  const kick = cashMoved && drawerWorks(settings);
  return {
    printReceipt,
    drawerInReceipt: kick && printReceipt,
    drawerAlone: kick && !printReceipt,
    openByHand: cashMoved && !kick,
  };
}

/**
 * The bytes for a receipt on this till's printer: the paper cut as set, and the drawer
 * pulse right after init when `openDrawer` and the drawer is set up.
 */
export function receiptBytes(
  doc: ReceiptDocument,
  settings: PrinterSettings,
  { openDrawer }: { openDrawer: boolean },
): Uint8Array {
  return renderEscPos({
    ...doc,
    cut: settings.printer.cut,
    drawer: openDrawer && drawerWorks(settings) ? { pin: settings.drawer.pin } : null,
  });
}

/** The bytes that only open the drawer (init, then the pulse on the set pin). */
export function drawerBytes(settings: PrinterSettings): Uint8Array {
  return drawerKick(settings.drawer.pin);
}

export type SendResult = { ok: true } | { ok: false; message: string };

/** Sends a job to this till's printer. Never throws: a failure comes back as a message. */
export async function sendJob(
  port: PrinterPort,
  settings: PrinterSettings,
  bytes: Uint8Array,
): Promise<SendResult> {
  const target = printTarget(settings);
  if (!target) return { ok: false, message: S.printer.isOff };
  try {
    await port.printRaw(target, bytes);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
}

function errorText(error: unknown): string {
  // Rust returns errors as plain strings.
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;
  return S.common.unexpectedError;
}

/** The printer for wherever the app runs. */
export function createPrinterPort(platform: Platform): PrinterPort {
  if (platform === 'desktop') return tauriPrinterPort();
  // The Vite dev server forwards Network jobs (dev-printer-bridge.ts), so the browser
  // preview and the Playwright tests can print to scripts/fake-printer.mjs.
  if (import.meta.env.DEV) return devServerPrinterPort();
  return {
    printRaw: () => Promise.reject(new Error(S.printer.desktopOnly)),
    listPrinters: () => Promise.resolve([]),
  };
}

function tauriPrinterPort(): PrinterPort {
  return {
    async printRaw(target, bytes) {
      // Tauri sends arguments as JSON, where Vec<u8> is an array of numbers.
      await invoke('print_raw', { target, bytes: Array.from(bytes) });
    },
    listPrinters: () => invoke<PrinterInfo[]>('printer_list'),
  };
}

/** The path the dev server's bridge listens on. */
export const DEV_PRINT_PATH = '/__dev/print-raw';

function devServerPrinterPort(): PrinterPort {
  return {
    async printRaw(target, bytes) {
      if (target.mode !== 'network') throw new Error(S.printer.windowsDesktopOnly);
      const response = await fetch(DEV_PRINT_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-printer-host': target.host,
          'x-printer-port': String(target.port),
        },
        body: bytes as Uint8Array<ArrayBuffer>,
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `${response.status} ${response.statusText}`);
      }
    },
    listPrinters: () => Promise.resolve([]),
  };
}
