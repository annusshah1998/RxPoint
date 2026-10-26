import {
  getDeviceSettings,
  getReturnReceiptData,
  getSaleReceiptData,
  recordDrawerTest,
  setReceiptStatus,
  type AppContext,
  type DeviceSettings,
  type ReceiptDocType,
} from '@app/db';
import type { ReceiptDocument } from '@app/receipt';
import { useMemo } from 'react';
import { useServices } from '../../app/services';
import {
  drawerBytes,
  drawerWorks,
  printPlan,
  printTarget,
  receiptBytes,
  sendJob,
  type PrintPlan,
  type PrinterPort,
  type PrinterSettings,
} from '../../platform/printer';
import { S } from '../../strings';
import { returnReceipt } from '../receipt/return-receipt';
import { saleReceipt } from '../receipt/sale-receipt';
import { printJobs, type PrintJobs } from './print-jobs';

/** A receipt the services recorded as `last_receipt` (§6.4). */
export interface ReceiptRef {
  docType: ReceiptDocType;
  docId: string;
}

/** What happened to a document's receipt and the drawer once it was saved. */
export interface PrintOutcome {
  settings: DeviceSettings;
  plan: PrintPlan;
  /** The receipt job, when printing is on with auto-print. */
  receiptJob: number | null;
  /** The drawer opening on its own (no receipt printing). */
  drawerJob: number | null;
}

export type Printing = ReturnType<typeof createPrinting>;

export function createPrinting(ctx: AppContext, port: PrinterPort, jobs: PrintJobs = printJobs) {
  const mark = (ref: ReceiptRef | null, status: 'done' | 'failed' | 'skipped') =>
    ref ? setReceiptStatus(ctx, ref, status) : Promise.resolve();

  /** Prints a receipt; null when printing is off. Runs in the background. */
  function printReceipt(
    doc: ReceiptDocument,
    settings: PrinterSettings,
    options: { title: string; openDrawer?: boolean; ref?: ReceiptRef | null },
  ): number | null {
    if (!printTarget(settings)) return null;
    const bytes = receiptBytes(doc, settings, { openDrawer: options.openDrawer ?? false });
    const ref = options.ref ?? null;
    return jobs.start(
      { kind: 'receipt', title: options.title, doc },
      {
        attempt: () => sendJob(port, settings, bytes),
        onResult: (ok) => mark(ref, ok ? 'done' : 'failed'),
        onSettle: () => mark(ref, 'skipped'),
      },
    );
  }

  /** Opens the drawer on its own; null when it can't be opened from here. */
  function openDrawer(settings: PrinterSettings): number | null {
    if (!drawerWorks(settings)) return null;
    const bytes = drawerBytes(settings);
    return jobs.start(
      { kind: 'drawer', title: S.printer.drawerTitle, doc: null },
      { attempt: () => sendJob(port, settings, bytes) },
    );
  }

  return {
    port,
    settings: () => getDeviceSettings(ctx),
    printReceipt,
    openDrawer,

    /**
     * After a sale, void or return has been saved: prints its receipt when printing is on
     * with auto-print (the drawer pulse inside it when cash moved), else opens the drawer
     * on its own when cash moved. Never throws and never waits for the printer.
     */
    afterDocument(options: {
      doc: ReceiptDocument | null;
      settings: DeviceSettings;
      cashMoved: boolean;
      ref: ReceiptRef | null;
      title: string;
    }): PrintOutcome {
      const { doc, settings } = options;
      const plan = printPlan(settings, { cashMoved: options.cashMoved });
      const receiptJob =
        plan.printReceipt && doc
          ? printReceipt(doc, settings, {
              title: options.title,
              openDrawer: plan.drawerInReceipt,
              ref: options.ref,
            })
          : null;
      // No receipt to carry the pulse (auto-print off, or the receipt couldn't be built).
      const drawerJob =
        plan.drawerAlone || (plan.drawerInReceipt && receiptJob === null)
          ? openDrawer(settings)
          : null;
      return { settings, plan, receiptJob, drawerJob };
    },

    /** A receipt asked for again: printed now when printing is on; never opens the drawer. */
    reprint(doc: ReceiptDocument, settings: DeviceSettings, title: string): PrintOutcome {
      const on = printTarget(settings) !== null;
      return {
        settings,
        plan: { printReceipt: on, drawerInReceipt: false, drawerAlone: false, openByHand: false },
        receiptJob: on ? printReceipt(doc, settings, { title }) : null,
        drawerJob: null,
      };
    },

    /** Settings → Test drawer, with the settings on screen (saved or not). Logged. */
    async testDrawer(settings: PrinterSettings): Promise<number | null> {
      if (settings.printer.mode === 'off') return null;
      await recordDrawerTest(ctx, { pin: settings.drawer.pin });
      return jobs.start(
        { kind: 'drawer', title: S.printer.drawerTitle, doc: null },
        { attempt: () => sendJob(port, settings, drawerBytes(settings)) },
      );
    },

    /** Settings → Print test page. */
    printTest(doc: ReceiptDocument, settings: PrinterSettings): number | null {
      if (!printTarget(settings)) return null;
      const bytes = receiptBytes(doc, settings, { openDrawer: false });
      return jobs.start(
        { kind: 'test', title: S.printer.testTitle, doc },
        { attempt: () => sendJob(port, settings, bytes) },
      );
    },

    /** Records that staff chose not to print a receipt (boot notice → Skip). */
    skip: (ref: ReceiptRef) => mark(ref, 'skipped'),
  };
}

/** Printing for the logged-in person. */
export function usePrinting(): Printing {
  const { ctx, printer } = useServices();
  return useMemo(() => createPrinting(ctx, printer), [ctx, printer]);
}

/**
 * The receipt of a sale, void (the sale marked VOID) or return, laid out for this till's
 * paper. `saleId` is needed for a void.
 */
export async function loadReceipt(
  ctx: AppContext,
  ref: ReceiptRef & { saleId?: string },
  settings: PrinterSettings,
  copy: 'original' | 'reprint' = 'original',
): Promise<ReceiptDocument> {
  const layout = { width: settings.printer.columns, timeZone: ctx.timeZone };
  if (ref.docType === 'return') {
    return returnReceipt(await getReturnReceiptData(ctx, ref.docId, { copy }), layout);
  }
  const saleId = ref.docType === 'void' ? ref.saleId : ref.docId;
  if (!saleId) throw new Error('A void receipt needs its sale');
  return saleReceipt(await getSaleReceiptData(ctx, saleId, { copy }), layout);
}
