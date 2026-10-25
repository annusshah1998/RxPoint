import {
  can,
  formatMoney,
  isAppError,
  parseMoney,
  parseQtyInput,
  toMajorString,
  type Permission,
  type WalletProvider,
} from '@app/core';
import {
  RETURN_REASONS,
  createReturn,
  getReturnableSale,
  planReturn,
  type ReturnableSale,
  type ReturnResult,
} from '@app/db';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useServices } from '../../app/services';
import { approvalPermissions, errorMessage, fieldErrors, isApprovalError } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Checkbox, Field, Loading, Notice, Select, TextInput } from '../../ui';
import { ApprovalFields, type ApprovalValue } from '../auth/ApprovalFields';

type RefundMethod = 'cash' | 'card' | 'wallet';

interface RefundRow {
  key: string;
  method: RefundMethod;
  provider: WalletProvider | null;
  reference: string | null;
  label: string;
  /** Card and wallet refunds are capped at what was paid that way. */
  max: number | null;
}

const rowKey = (method: string, provider: string | null) => `${method}:${provider ?? ''}`;

/** Takes items back from a sale: quantities, reason, refund preview and how it is paid back. */
export function ReturnForm({
  saleId,
  onDone,
  onCancel,
}: {
  saleId: string;
  onDone: (result: ReturnResult) => void;
  onCancel: () => void;
}) {
  const { ctx } = useServices();
  const sale = useQuery({
    queryKey: ['returnable', saleId],
    queryFn: () => getReturnableSale(ctx, saleId),
  });
  if (sale.isPending) return <Loading />;
  if (sale.isError) {
    return (
      <>
        <Notice tone="bad">{errorMessage(sale.error)}</Notice>
        <Button onClick={onCancel}>{S.common.cancel}</Button>
      </>
    );
  }
  return <ReturnFields sale={sale.data} onDone={onDone} onCancel={onCancel} />;
}

function ReturnFields({
  sale,
  onDone,
  onCancel,
}: {
  sale: ReturnableSale;
  onDone: (result: ReturnResult) => void;
  onCancel: () => void;
}) {
  const { ctx } = useServices();
  const [qty, setQty] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sale.lines.map((l) => [l.saleLineId, l.canRestock])),
  );
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  /** Refund amounts typed for one refund total; a new total starts from the suggestion. */
  const [edited, setEdited] = useState<{ total: number; amounts: Record<string, string> } | null>(
    null,
  );
  const [approval, setApproval] = useState<ApprovalValue>({ userId: '', pin: '' });
  const [asked, setAsked] = useState<Permission[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const parsed = sale.lines.map((l) => {
    const text = qty[l.saleLineId]?.trim() ?? '';
    if (!text) return { qty: 0, error: null };
    const unit = l.units.find((u) => u.id === l.defaultUnitId) ?? l.units.find((u) => u.qty === 1);
    if (!unit) return { qty: 0, error: S.returns.badQty };
    const result = parseQtyInput(text, l.units, unit);
    if (result.ok) return { qty: result.baseQty, error: null };
    return result.error === 'zero' ? { qty: 0, error: null } : { qty: 0, error: S.returns.badQty };
  });
  const lines = sale.lines.map((l, i) => ({
    saleLineId: l.saleLineId,
    qty: parsed[i]!.qty,
    restock: l.canRestock && (restock[l.saleLineId] ?? false),
  }));
  const typed = lines.some((l) => l.qty > 0) && parsed.every((p) => p.error === null);

  const plan = useQuery({
    queryKey: ['return-plan', sale.saleId, lines],
    queryFn: () => planReturn(ctx, { saleId: sale.saleId, lines }),
    enabled: typed,
    placeholderData: keepPreviousData,
  });
  const preview =
    typed && plan.data && Object.keys(plan.data.fields).length === 0 ? plan.data : null;
  const total = preview?.refundTotal ?? 0;

  const rows: RefundRow[] = [
    {
      key: rowKey('cash', null),
      method: 'cash',
      provider: null,
      reference: null,
      label: S.returns.cash,
      max: null,
    },
    ...sale.channels
      .filter((c) => c.method !== 'cash' && c.left > 0)
      .map((c) => ({
        key: rowKey(c.method, c.provider),
        method: c.method,
        provider: c.provider,
        reference: c.reference,
        label:
          c.method === 'card'
            ? S.returns.card(c.reference)
            : S.returns.wallet(S.receipt.wallets[c.provider ?? 'other'] ?? 'Wallet', c.reference),
        max: c.left,
      })),
  ];
  const suggested: Record<string, string> = Object.fromEntries(
    (preview?.suggestedRefunds ?? []).map((r) => [
      rowKey(r.method, r.provider),
      toMajorString(r.amount),
    ]),
  );
  const amounts =
    edited && preview && edited.total === preview.refundTotal ? edited.amounts : suggested;
  const amountErrors = rows.map((r) => {
    const text = amounts[r.key]?.trim() ?? '';
    return text && parseMoney(text) === null ? S.validation.badPrice : null;
  });

  // Who must approve: what the preview says the acting user lacks, or what the service asked.
  const needs = preview && preview.needs.length > 0 ? preview.needs : asked;

  const fields = { ...fieldErrors(error) };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (parsed.some((p) => p.error) || amountErrors.some(Boolean)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createReturn(ctx, {
        saleId: sale.saleId,
        lines,
        reason: reason as (typeof RETURN_REASONS)[number],
        note,
        refunds: rows.map((r) => ({
          method: r.method,
          provider: r.provider,
          reference: r.reference,
          amount: parseMoney(amounts[r.key] ?? '') ?? 0,
        })),
        expectedRefund: total,
        approval: needs ? approval : null,
      });
      onDone(result);
    } catch (err) {
      setAsked((n) => approvalPermissions(err) ?? n);
      if (isAppError(err) && err.code === 'TOTAL_CHANGED') void plan.refetch();
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const showError = error != null && !approvalPermissions(error) && !isApprovalError(error);
  return (
    <form onSubmit={submit} noValidate className="return-form">
      <h3>{S.returns.title(sale.invoiceNo)}</h3>
      {sale.late && <Notice tone="warn">{S.returns.late(sale.daysSince, sale.returnDays)}</Notice>}
      {showError && <Notice tone="bad">{errorMessage(error)}</Notice>}
      <p className="muted">{S.returns.intro}</p>
      <table className="table table-compact">
        <thead>
          <tr>
            <th>{S.returns.item}</th>
            <th>{S.returns.sold}</th>
            <th>{S.returns.returned}</th>
            <th>{S.returns.returnNow}</th>
            <th>{S.returns.restock}</th>
          </tr>
        </thead>
        <tbody>
          {sale.lines.map((l, i) => {
            const problem =
              parsed[i]!.error ?? fields[`lines.${i}.qty`] ?? plan.data?.fields[`lines.${i}.qty`];
            return (
              <tr key={l.saleLineId} className={l.returnable === 0 ? 'row-muted' : ''}>
                <td>{l.description}</td>
                <td>{l.soldText}</td>
                <td>{l.returned > 0 ? l.returnedText : '—'}</td>
                <td>
                  <TextInput
                    aria-label={S.returns.returnNowLabel(l.description)}
                    aria-invalid={problem ? true : undefined}
                    placeholder={S.returns.qtyHint}
                    value={qty[l.saleLineId] ?? ''}
                    onChange={(e) => setQty((q) => ({ ...q, [l.saleLineId]: e.target.value }))}
                    disabled={l.returnable === 0}
                    size={8}
                  />
                  {problem && (
                    <span className="field-error" role="alert">
                      {problem}
                    </span>
                  )}
                </td>
                <td>
                  {l.canRestock ? (
                    <Checkbox
                      label={S.returns.restock}
                      checked={restock[l.saleLineId] ?? false}
                      onChange={(checked) => setRestock((r) => ({ ...r, [l.saleLineId]: checked }))}
                      disabled={l.returnable === 0}
                    />
                  ) : (
                    <span className="muted">{S.returns.expired}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {fields.lines && <Notice tone="bad">{fields.lines}</Notice>}

      <div className="row">
        <Field label={S.returns.reason} error={fields.reason}>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">{S.returns.chooseReason}</option>
            {RETURN_REASONS.map((r) => (
              <option key={r} value={r}>
                {S.returns.reasons[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={S.returns.note} error={fields.note}>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>

      {preview && (
        <div className="return-summary">
          <table className="table table-compact">
            <tbody>
              <tr>
                <td>{S.returns.itemsBack}</td>
                <td className="num">{formatMoney(preview.refundNet)}</td>
              </tr>
              {preview.rounding !== 0 && (
                <tr>
                  <td>{S.returns.rounding}</td>
                  <td className="num">{formatMoney(preview.rounding)}</td>
                </tr>
              )}
              <tr>
                <th>{S.returns.dueBack}</th>
                <th className="num" data-testid="return-total">
                  {formatMoney(preview.refundTotal)}
                </th>
              </tr>
            </tbody>
          </table>
          {total === 0 ? (
            <Notice tone="info">{S.returns.nothingDue}</Notice>
          ) : (
            <fieldset className="refund-rows">
              <legend>{S.returns.payBack}</legend>
              {fields.refunds && <Notice tone="bad">{fields.refunds}</Notice>}
              <div className="row">
                {rows.map((r, i) => (
                  <Field
                    key={r.key}
                    label={r.label}
                    hint={r.max !== null ? S.returns.upTo(formatMoney(r.max)) : undefined}
                    error={amountErrors[i] ?? fields[`refunds.${i}.amount`]}
                  >
                    <TextInput
                      value={amounts[r.key] ?? ''}
                      inputMode="decimal"
                      placeholder="0"
                      onChange={(e) =>
                        setEdited({
                          total: preview.refundTotal,
                          amounts: { ...amounts, [r.key]: e.target.value },
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}

      {needs && (
        <ApprovalFields
          eligible={(role) => needs.every((p) => can(role, p))}
          value={approval}
          onChange={setApproval}
          errors={isApprovalError(error) ? fields : {}}
        />
      )}
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={busy}>
          {preview && total > 0 ? S.returns.submit(formatMoney(total)) : S.returns.submitNoRefund}
        </Button>
        <Button onClick={onCancel}>{S.common.cancel}</Button>
      </div>
    </form>
  );
}
