import { can, formatMoney, localTime } from '@app/core';
import {
  DEFAULT_DEVICE_SETTINGS,
  describeRefund,
  getDeviceSettings,
  getSale,
  listSales,
  recordReprint,
  voidSale,
  type ReturnResult,
  type SaleView,
  type VoidResult,
} from '@app/db';
import type { ReceiptDocument } from '@app/receipt';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useServices } from '../../app/services';
import { approvalNeeded, errorMessage, fieldErrors, isApprovalError } from '../../lib/errors';
import { useDebounced } from '../../lib/use-debounced';
import { S } from '../../strings';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Loading,
  Modal,
  Notice,
  PageHeader,
  TextInput,
} from '../../ui';
import { ApprovalFields, type ApprovalValue } from '../auth/ApprovalFields';
import { ReceiptOutput } from '../printing/PrintStatus';
import { loadReceipt, usePrinting, type PrintOutcome, type ReceiptRef } from '../printing/printing';
import { ReturnForm } from './ReturnForm';

export function SalesScreen() {
  const { ctx } = useServices();
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 150);
  const sales = useQuery({
    queryKey: ['sales', debounced],
    queryFn: () => listSales(ctx, { query: debounced || null, limit: 200 }),
    placeholderData: keepPreviousData,
  });
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="page">
      <PageHeader title={S.sales.title} subtitle={S.sales.subtitle} />
      <div className="search-bar">
        <TextInput
          className="search-input"
          aria-label={S.sales.search}
          placeholder={S.sales.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      {sales.isPending ? (
        <Loading />
      ) : sales.data?.length === 0 ? (
        <EmptyState>{S.sales.none}</EmptyState>
      ) : (
        <Card>
          <table className="table table-hover">
            <thead>
              <tr>
                <th>{S.sales.invoice}</th>
                <th>{S.sales.time}</th>
                <th>{S.sales.cashier}</th>
                <th className="num">{S.sales.items}</th>
                <th>{S.sales.paidBy}</th>
                <th className="num">{S.sales.total}</th>
              </tr>
            </thead>
            <tbody>
              {sales.data?.map((s) => (
                <tr key={s.id} onClick={() => setOpen(s.id)} className="clickable">
                  <td>
                    <button type="button" className="link-btn" onClick={() => setOpen(s.id)}>
                      {s.invoiceNo}
                    </button>{' '}
                    {s.voided && <Badge tone="bad">{S.sales.voided}</Badge>}
                    {s.returned && <Badge tone="warn">{S.sales.returned}</Badge>}
                  </td>
                  <td>{localTime(new Date(s.createdAt), ctx.timeZone)}</td>
                  <td>{s.cashier}</td>
                  <td className="num">{s.lineCount}</td>
                  <td>{s.methods.map((m) => S.sales.methods[m]).join(' + ')}</td>
                  <td className="num">{formatMoney(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {open && <SaleDetail saleId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** A receipt on screen or on paper, with how printing it went. */
interface Output {
  doc: ReceiptDocument | null;
  printed: PrintOutcome;
  title: string;
}

function SaleDetail({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  const { ctx, store } = useServices();
  const printing = usePrinting();
  const queryClient = useQueryClient();
  const sale = useQuery({ queryKey: ['sale', saleId], queryFn: () => getSale(ctx, saleId) });
  const device = useQuery({ queryKey: ['device-settings'], queryFn: () => getDeviceSettings(ctx) });
  const [receipt, setReceipt] = useState<Output | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voided, setVoided] = useState<{ result: VoidResult; output: Output } | null>(null);
  const [returning, setReturning] = useState(false);
  const [returned, setReturned] = useState<{ result: ReturnResult; output: Output } | null>(null);
  const [error, setError] = useState<unknown>(null);

  /**
   * After a void or return is saved: its receipt, printed (with the drawer pulse when cash
   * goes back) or shown. A receipt that can't be built never undoes what was saved.
   */
  async function afterSaved(
    ref: ReceiptRef & { saleId?: string },
    number: string,
    cashMoved: boolean,
  ): Promise<Output> {
    let settings = DEFAULT_DEVICE_SETTINGS;
    let doc: ReceiptDocument | null = null;
    try {
      settings = await getDeviceSettings(ctx);
      doc = await loadReceipt(ctx, ref, settings);
    } catch (err) {
      setError(err);
    }
    const title = S.printer.receiptTitle(number);
    const printed = printing.afterDocument({
      doc,
      settings,
      cashMoved,
      ref: { docType: ref.docType, docId: ref.docId },
      title,
    });
    return { doc, printed, title };
  }

  async function finishReturn(result: ReturnResult) {
    const output = await afterSaved(
      { docType: 'return', docId: result.returnId },
      result.returnNo,
      result.openDrawer,
    );
    setReturned({ result, output });
    setReturning(false);
    await queryClient.invalidateQueries();
  }

  async function finishVoid(result: VoidResult) {
    const output = await afterSaved(
      { docType: 'void', docId: result.voidId, saleId },
      result.invoiceNo,
      result.openDrawer,
    );
    setVoided({ result, output });
    await queryClient.invalidateQueries();
  }

  async function showReceipt(view: SaleView) {
    try {
      await recordReprint(ctx, view.id);
      const settings = await getDeviceSettings(ctx);
      const doc = await loadReceipt(ctx, { docType: 'sale', docId: view.id }, settings, 'reprint');
      const title = S.printer.receiptTitle(view.invoiceNo);
      setReceipt({ doc, printed: printing.reprint(doc, settings, title), title });
    } catch (err) {
      setError(err);
    }
  }

  const view = sale.data;
  return (
    <Modal title={view ? S.sales.detailTitle(view.invoiceNo) : S.sales.title} onClose={onClose}>
      {!view ? (
        <Loading />
      ) : returned ? (
        <>
          <Notice tone="good">{S.returns.done(returned.result.returnNo)}</Notice>
          <ul>
            {describeRefund(returned.result).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
          <ReceiptOutput {...outputProps(returned.output)} />
          <Button variant="primary" onClick={onClose}>
            {S.common.close}
          </Button>
        </>
      ) : returning ? (
        <ReturnForm
          saleId={view.id}
          onDone={(result) => void finishReturn(result)}
          onCancel={() => setReturning(false)}
        />
      ) : voided ? (
        <>
          <Notice tone="good">{S.sales.voidDone}</Notice>
          <ul>
            {describeRefund(voided.result).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
          <ReceiptOutput {...outputProps(voided.output)} />
          <Button variant="primary" onClick={onClose}>
            {S.common.close}
          </Button>
        </>
      ) : voiding ? (
        <VoidForm
          view={view}
          onDone={(result) => void finishVoid(result)}
          onCancel={() => setVoiding(false)}
        />
      ) : (
        <>
          {error != null && <Notice tone="bad">{errorMessage(error)}</Notice>}
          {view.voided && (
            <Notice tone="bad">
              {S.sales.voided}: {view.voided.reason} ({view.voided.by}
              {view.voided.approvedBy ? `, ${view.voided.approvedBy}` : ''})
            </Notice>
          )}
          <table className="table table-compact">
            <tbody>
              {view.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td>{l.qtyText}</td>
                  <td className="num">{formatMoney(l.net)}</td>
                </tr>
              ))}
              <tr>
                <th colSpan={2}>{S.sales.total}</th>
                <th className="num">{formatMoney(view.total)}</th>
              </tr>
            </tbody>
          </table>
          {view.returns.length > 0 && (
            <>
              <h3>{S.sales.returnsSoFar}</h3>
              <ul>
                {view.returns.map((r) => (
                  <li key={r.id}>
                    {S.sales.returnRow(r.returnNo, formatMoney(r.refundTotal), r.by)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {receipt && <ReceiptOutput key={receipt.printed.receiptJob} {...outputProps(receipt)} />}
          <div className="form-actions">
            <Button onClick={() => void showReceipt(view)}>
              {(device.data?.printer.mode ?? 'off') === 'off'
                ? S.sales.reprint
                : S.sales.reprintPrint}
            </Button>
            {view.canVoid && can(store.userRole, 'sale.sell') && (
              <Button variant="danger" onClick={() => setVoiding(true)}>
                {S.sales.void}
              </Button>
            )}
            {view.canReturn && can(store.userRole, 'sale.sell') && (
              <Button onClick={() => setReturning(true)}>{S.sales.returnItems}</Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              {S.common.close}
            </Button>
          </div>
          {!view.canVoid && !view.voided && <p className="muted">{S.sales.voidClosedShift}</p>}
        </>
      )}
    </Modal>
  );
}

function outputProps(output: Output) {
  return { doc: output.doc, outcome: output.printed, title: output.title };
}

function VoidForm({
  view,
  onDone,
  onCancel,
}: {
  view: SaleView;
  onDone: (result: VoidResult) => void;
  onCancel: () => void;
}) {
  const { ctx } = useServices();
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState<ApprovalValue>({ userId: '', pin: '' });
  const [needs, setNeeds] = useState<ReturnType<typeof approvalNeeded>>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await voidSale(ctx, { saleId: view.id, reason, approval: needs ? approval : null }));
    } catch (err) {
      setNeeds((n) => approvalNeeded(err) ?? n);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const fields = fieldErrors(error);
  return (
    <form onSubmit={submit} noValidate>
      <h3>{S.sales.voidTitle(view.invoiceNo)}</h3>
      {error != null && !approvalNeeded(error) && Object.keys(fields).length === 0 && (
        <Notice tone="bad">{errorMessage(error)}</Notice>
      )}
      <Field label={S.sales.voidReason} hint={S.sales.voidHint} error={fields.reason}>
        <TextInput value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      {needs && (
        <ApprovalFields
          permission={needs}
          value={approval}
          onChange={setApproval}
          errors={isApprovalError(error) ? fields : {}}
        />
      )}
      <div className="form-actions">
        <Button type="submit" variant="danger" disabled={busy}>
          {S.sales.void}
        </Button>
        <Button onClick={onCancel}>{S.common.cancel}</Button>
      </div>
    </form>
  );
}
