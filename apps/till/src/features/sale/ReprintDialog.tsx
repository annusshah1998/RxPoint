import { getDeviceSettings, getLastSale, recordReprint } from '@app/db';
import type { ReceiptDocument } from '@app/receipt';
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../app/services';
import { errorMessage } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Loading, Modal, Notice } from '../../ui';
import { ReceiptOutput } from '../printing/PrintStatus';
import { loadReceipt, usePrinting, type PrintOutcome } from '../printing/printing';

type State =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'shown'; invoiceNo: string; doc: ReceiptDocument; printed: PrintOutcome }
  | { kind: 'failed'; error: unknown };

/**
 * Ctrl+P: the receipt of this till's last sale again, marked REPRINT and logged, the same
 * way as "Show receipt again" on the Sales screen. It prints when printing is on (without
 * opening the drawer) and shows on screen when printing is off.
 */
export function ReprintDialog({ onClose }: { onClose: () => void }) {
  const { ctx } = useServices();
  const printing = usePrinting();
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Once per opening, so a re-render (or React's development double run) logs one reprint.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const last = await getLastSale(ctx);
        if (!last) {
          setState({ kind: 'none' });
          return;
        }
        await recordReprint(ctx, last.id);
        const device = await getDeviceSettings(ctx);
        const doc = await loadReceipt(ctx, { docType: 'sale', docId: last.id }, device, 'reprint');
        const printed = printing.reprint(doc, device, S.printer.receiptTitle(last.invoiceNo));
        setState({ kind: 'shown', invoiceNo: last.invoiceNo, doc, printed });
      } catch (error) {
        setState({ kind: 'failed', error });
      }
    })();
  }, [ctx, printing]);

  return (
    <Modal title={S.sale.reprintLast} onClose={onClose}>
      {state.kind === 'loading' && <Loading />}
      {state.kind === 'none' && <Notice tone="info">{S.sale.noLastSale}</Notice>}
      {state.kind === 'failed' && <Notice tone="bad">{errorMessage(state.error)}</Notice>}
      {state.kind === 'shown' && (
        <>
          <p>
            <strong>{S.pay.invoice(state.invoiceNo)}</strong>
          </p>
          <ReceiptOutput
            doc={state.doc}
            outcome={state.printed}
            title={S.printer.receiptTitle(state.invoiceNo)}
          />
        </>
      )}
      {state.kind !== 'loading' && (
        <div className="form-actions">
          <Button variant="primary" autoFocus onClick={onClose}>
            {S.common.close}
          </Button>
        </div>
      )}
    </Modal>
  );
}
