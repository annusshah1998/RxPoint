import { getDeviceSettings, getLastSale, getSaleReceiptData, recordReprint } from '@app/db';
import type { ReceiptDocument } from '@app/receipt';
import { useEffect, useRef, useState } from 'react';
import { useServices } from '../../app/services';
import { errorMessage } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Loading, Modal, Notice } from '../../ui';
import { ReceiptPreview } from '../receipt/ReceiptPreview';
import { saleReceipt } from '../receipt/sale-receipt';

type State =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'shown'; invoiceNo: string; doc: ReceiptDocument }
  | { kind: 'failed'; error: unknown };

/**
 * Ctrl+P: the receipt of this till's last sale again, marked REPRINT and logged, the same
 * way as "Show receipt again" on the Sales screen. Printing is not built yet, so it is
 * shown on screen.
 */
export function ReprintDialog({ onClose }: { onClose: () => void }) {
  const { ctx } = useServices();
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
        const [data, device] = await Promise.all([
          getSaleReceiptData(ctx, last.id, { copy: 'reprint' }),
          getDeviceSettings(ctx),
        ]);
        const doc = saleReceipt(data, { width: device.printer.columns, timeZone: ctx.timeZone });
        setState({ kind: 'shown', invoiceNo: last.invoiceNo, doc });
      } catch (error) {
        setState({ kind: 'failed', error });
      }
    })();
  }, [ctx]);

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
          <Notice tone="info">{S.pay.printingOff}</Notice>
          <ReceiptPreview doc={state.doc} />
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
