import { getDeviceSettings, getReceiptNotice, type DeviceSettings } from '@app/db';
import type { ReceiptDocument } from '@app/receipt';
import { useEffect, useState } from 'react';
import { useServices } from '../../app/services';
import { errorMessage } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Modal, Notice } from '../../ui';
import { ReceiptPreview } from '../receipt/ReceiptPreview';
import { printJobs, usePrintJob, useUnseenFailures, type PrintJob } from './print-jobs';
import { loadReceipt, usePrinting, type PrintOutcome } from './printing';

function failedText(job: PrintJob): string {
  const why = job.error ?? S.common.unexpectedError;
  if (job.kind === 'drawer') return S.printer.drawerFailed(why);
  if (job.kind === 'test') return S.printer.testNotPrinted(why);
  return S.printer.notPrinted(why);
}

function progressText(job: PrintJob): string {
  if (job.kind === 'drawer') return job.status === 'sent' ? S.printer.opened : S.printer.opening;
  if (job.status === 'printing') return S.printer.printing;
  return job.kind === 'test' ? S.printer.testSent : S.printer.sent;
}

/**
 * How one print job went: printing, sent, or failed with [Retry] and (for a receipt)
 * [Show on screen]. While this shows, the failure isn't repeated in the problems bar.
 */
export function PrintStatus({ jobId, onShow }: { jobId: number; onShow?: () => void }) {
  const job = usePrintJob(jobId);
  if (!job) return null;
  if (job.status !== 'failed') {
    return (
      <Notice tone={job.status === 'sent' ? 'good' : 'info'}>
        <span data-testid="print-status">{progressText(job)}</span>
      </Notice>
    );
  }
  return (
    <Notice tone="bad">
      <span data-testid="print-status">{failedText(job)}</span>{' '}
      <span className="notice-actions">
        <Button size="small" onClick={() => printJobs.retry(job.id)}>
          {S.printer.retry}
        </Button>
        {job.doc && onShow && (
          <Button
            size="small"
            onClick={() => {
              printJobs.settle(job.id);
              onShow();
            }}
          >
            {S.printer.showOnScreen}
          </Button>
        )}
      </span>
    </Notice>
  );
}

/**
 * The receipt and the drawer after a sale, void or return: the print status when printing
 * is on (the preview only on request), else the preview; "Open the drawer by hand" when
 * cash moved and the drawer didn't open from here.
 */
export function ReceiptOutput({
  doc,
  outcome,
  title,
}: {
  doc: ReceiptDocument | null;
  outcome: PrintOutcome;
  title: string;
}) {
  const printing = usePrinting();
  const { settings, plan } = outcome;
  const [manualJob, setManualJob] = useState<number | null>(null);
  const [shown, setShown] = useState(false);
  const on = settings.printer.mode !== 'off';
  const jobId = outcome.receiptJob ?? manualJob;
  const job = usePrintJob(jobId);
  // The pulse was inside a receipt that didn't print, so the drawer didn't open either.
  const drawerMissed = plan.drawerInReceipt && job?.status === 'failed';

  if (!on) {
    return (
      <>
        <Notice tone="info">
          {S.pay.printingOff}
          {plan.openByHand ? ` ${S.pay.openDrawer}` : ''}
        </Notice>
        {doc && <ReceiptPreview doc={doc} />}
      </>
    );
  }
  return (
    <>
      {jobId !== null && <PrintStatus jobId={jobId} onShow={() => setShown(true)} />}
      {outcome.drawerJob !== null && <PrintStatus jobId={outcome.drawerJob} />}
      {(plan.openByHand || drawerMissed) && <Notice tone="warn">{S.pay.openDrawer}</Notice>}
      {!plan.printReceipt && doc && manualJob === null && (
        <div className="form-actions">
          <Button onClick={() => setManualJob(printing.printReceipt(doc, settings, { title }))}>
            {S.printer.print}
          </Button>
        </div>
      )}
      {doc && (!plan.printReceipt || shown) && <ReceiptPreview doc={doc} />}
    </>
  );
}

/**
 * Print failures no screen is showing any more (the cashier had already moved on to the
 * next sale), on every screen until someone retries, shows or dismisses them.
 */
export function PrintProblems() {
  const failures = useUnseenFailures();
  const [showing, setShowing] = useState<PrintJob | null>(null);
  if (failures.length === 0 && !showing) return null;
  return (
    <div className="print-problems" role="region" aria-label={S.printer.problems}>
      {failures.map((job) => (
        <Notice key={job.id} tone="bad">
          {job.kind === 'drawer'
            ? failedText(job)
            : S.printer.titledNotPrinted(job.title, job.error ?? S.common.unexpectedError)}{' '}
          <span className="notice-actions">
            <Button size="small" onClick={() => printJobs.retry(job.id)}>
              {S.printer.retry}
            </Button>
            {job.doc && (
              <Button
                size="small"
                onClick={() => {
                  printJobs.settle(job.id);
                  setShowing(job);
                }}
              >
                {S.printer.showOnScreen}
              </Button>
            )}
            <Button size="small" variant="ghost" onClick={() => printJobs.settle(job.id)}>
              {S.printer.dismiss}
            </Button>
          </span>
        </Notice>
      ))}
      {showing?.doc && (
        <Modal title={showing.title} onClose={() => setShowing(null)}>
          <ReceiptPreview doc={showing.doc} />
        </Modal>
      )}
    </div>
  );
}

/**
 * After a restart or login: "Receipt for T1-000123 may not have printed — [Print] [Skip]",
 * when the last receipt was still pending (e.g. a power cut) or failed (§5.1, §6.4).
 */
export function ReceiptNotice() {
  const { ctx } = useServices();
  const printing = usePrinting();
  const [notice, setNotice] = useState<{
    ref: NonNullable<Awaited<ReturnType<typeof getReceiptNotice>>>;
    settings: DeviceSettings;
  } | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [shown, setShown] = useState<ReceiptDocument | null>(null);
  const [doc, setDoc] = useState<ReceiptDocument | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([getReceiptNotice(ctx), getDeviceSettings(ctx)]).then(([ref, settings]) => {
      // With printing now off there is nothing to print it on.
      if (live && ref && settings.printer.mode !== 'off') setNotice({ ref, settings });
    }, console.error);
    return () => {
      live = false;
    };
    // Once per login.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!notice) return null;
  const { ref, settings } = notice;

  async function print() {
    setError(null);
    try {
      const receipt = await loadReceipt(ctx, ref, settings);
      setDoc(receipt);
      setJobId(
        printing.printReceipt(receipt, settings, {
          title: S.printer.receiptTitle(ref.number),
          ref,
        }),
      );
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div
      className="receipt-notice"
      role="region"
      aria-label={S.printer.mayNotHavePrinted(ref.number)}
    >
      {jobId === null ? (
        <Notice tone="warn">
          {S.printer.mayNotHavePrinted(ref.number)}{' '}
          <span className="notice-actions">
            <Button size="small" variant="primary" onClick={() => void print()}>
              {S.printer.printNow}
            </Button>
            <Button
              size="small"
              onClick={() => {
                void printing.skip(ref).catch(console.error);
                setNotice(null);
              }}
            >
              {S.printer.skip}
            </Button>
          </span>
        </Notice>
      ) : (
        <>
          <PrintStatus jobId={jobId} onShow={() => setShown(doc)} />
          <Button size="small" variant="ghost" onClick={() => setNotice(null)}>
            {S.printer.dismiss}
          </Button>
        </>
      )}
      {error != null && <Notice tone="bad">{errorMessage(error)}</Notice>}
      {shown && <ReceiptPreview doc={shown} />}
    </div>
  );
}
