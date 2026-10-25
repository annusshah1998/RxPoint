import { can, formatMoney, localTime } from '@app/core';
import {
  describeRefund,
  getDeviceSettings,
  getReturnReceiptData,
  getSale,
  getSaleReceiptData,
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
import { ReceiptPreview } from '../receipt/ReceiptPreview';
import { returnReceipt } from '../receipt/return-receipt';
import { saleReceipt } from '../receipt/sale-receipt';
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

function SaleDetail({ saleId, onClose }: { saleId: string; onClose: () => void }) {
  const { ctx, store } = useServices();
  const queryClient = useQueryClient();
  const sale = useQuery({ queryKey: ['sale', saleId], queryFn: () => getSale(ctx, saleId) });
  const [receipt, setReceipt] = useState<ReceiptDocument | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [voided, setVoided] = useState<VoidResult | null>(null);
  const [returning, setReturning] = useState(false);
  const [returned, setReturned] = useState<{
    result: ReturnResult;
    receipt: ReceiptDocument | null;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function finishReturn(result: ReturnResult) {
    let receiptDoc: ReceiptDocument | null = null;
    try {
      const [data, device] = await Promise.all([
        getReturnReceiptData(ctx, result.returnId),
        getDeviceSettings(ctx),
      ]);
      receiptDoc = returnReceipt(data, { width: device.printer.columns, timeZone: ctx.timeZone });
    } catch (err) {
      setError(err);
    }
    setReturned({ result, receipt: receiptDoc });
    setReturning(false);
    await queryClient.invalidateQueries();
  }

  async function showReceipt(view: SaleView) {
    try {
      await recordReprint(ctx, view.id);
      const [data, device] = await Promise.all([
        getSaleReceiptData(ctx, view.id, { copy: 'reprint' }),
        getDeviceSettings(ctx),
      ]);
      setReceipt(saleReceipt(data, { width: device.printer.columns, timeZone: ctx.timeZone }));
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
          {returned.receipt && <ReceiptPreview doc={returned.receipt} />}
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
            {describeRefund(voided).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
          <Button variant="primary" onClick={onClose}>
            {S.common.close}
          </Button>
        </>
      ) : voiding ? (
        <VoidForm
          view={view}
          onDone={async (result) => {
            setVoided(result);
            await queryClient.invalidateQueries();
          }}
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
          {receipt && <ReceiptPreview doc={receipt} />}
          <div className="form-actions">
            <Button onClick={() => void showReceipt(view)}>{S.sales.reprint}</Button>
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
