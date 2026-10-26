import { CASH_CATEGORIES, recordCashMovement, recordNoSale } from '@app/db';
import { useState, type FormEvent } from 'react';
import { useAction } from '../../app/services';
import { approvalNeeded, errorMessage, fieldErrors, isApprovalError } from '../../lib/errors';
import { readMoney } from '../../lib/money-input';
import { S } from '../../strings';
import { Button, Field, Modal, Notice, Select, TextInput } from '../../ui';
import { ApprovalFields, type ApprovalValue } from '../auth/ApprovalFields';

type CashKind = 'pay_in' | 'pay_out';

const noApproval: ApprovalValue = { userId: '', pin: '' };
const defaultCategory = (kind: CashKind) => (kind === 'pay_in' ? 'change' : 'expense');

/**
 * Cash put into or taken out of the drawer. `kind` null lets the cashier choose (Alt+C on
 * the Sale screen); it starts on Cash out, the usual one.
 */
export function CashMovementDialog({
  kind: fixedKind,
  onClose,
}: {
  kind: CashKind | null;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<CashKind>(fixedKind ?? 'pay_out');
  const [values, setValues] = useState({
    category: defaultCategory(kind) as string,
    amount: '',
    note: '',
  });
  const [amountError, setAmountError] = useState<string>();
  const [approval, setApproval] = useState<ApprovalValue>(noApproval);
  const record = useAction(recordCashMovement, { onSuccess: onClose });
  const [needs, setNeeds] = useState<ReturnType<typeof approvalNeeded>>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const amount = readMoney(values.amount);
    if ('error' in amount) {
      setAmountError(amount.error);
      return;
    }
    setAmountError(undefined);
    record.mutate(
      {
        kind,
        category: values.category as (typeof CASH_CATEGORIES)[number],
        amount: amount.value ?? 0,
        note: values.note,
        approval: needs ? approval : null,
      },
      { onError: (error) => setNeeds((n) => approvalNeeded(error) ?? n) },
    );
  }

  function changeKind(next: CashKind) {
    setKind(next);
    // Follow the usual category for the new direction unless one was picked.
    setValues((v) =>
      v.category === defaultCategory(kind) ? { ...v, category: defaultCategory(next) } : v,
    );
  }

  const errors = fieldErrors(record.error);
  const approvalErrors = isApprovalError(record.error) ? errors : {};
  const title =
    fixedKind === null
      ? S.shift.cashInOutTitle
      : kind === 'pay_in'
        ? S.shift.payInTitle
        : S.shift.payOutTitle;
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {record.isError && !approvalNeeded(record.error) && Object.keys(errors).length === 0 && (
          <Notice tone="bad">{errorMessage(record.error)}</Notice>
        )}
        <div className="row">
          <Field label={S.shift.amount} error={amountError ?? errors.amount}>
            <TextInput
              value={values.amount}
              onChange={(e) => setValues((v) => ({ ...v, amount: e.target.value }))}
              inputMode="decimal"
              autoFocus
            />
          </Field>
          {fixedKind === null && (
            <Field label={S.shift.direction}>
              <Select value={kind} onChange={(e) => changeKind(e.target.value as CashKind)}>
                <option value="pay_out">{S.shift.payOut}</option>
                <option value="pay_in">{S.shift.payIn}</option>
              </Select>
            </Field>
          )}
          <Field label={S.shift.category}>
            <Select
              value={values.category}
              onChange={(e) => setValues((v) => ({ ...v, category: e.target.value }))}
            >
              {CASH_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {S.shift.categories[c]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={S.shift.note} hint={S.shift.noteHint} error={errors.note}>
          <TextInput
            value={values.note}
            onChange={(e) => setValues((v) => ({ ...v, note: e.target.value }))}
          />
        </Field>
        {needs && (
          <ApprovalFields
            permission={needs}
            value={approval}
            onChange={setApproval}
            errors={approvalErrors}
          />
        )}
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={record.isPending}>
            {S.shift.record}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Records opening the drawer without a sale (the drawer itself is opened by hand for now). */
export function NoSaleDialog({ onClose }: { onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState<ApprovalValue>(noApproval);
  const [needs, setNeeds] = useState<ReturnType<typeof approvalNeeded>>(null);
  const record = useAction(recordNoSale, { onSuccess: onClose });

  function submit(e: FormEvent) {
    e.preventDefault();
    record.mutate(
      { reason, approval: needs ? approval : null },
      { onError: (error) => setNeeds((n) => approvalNeeded(error) ?? n) },
    );
  }

  const errors = fieldErrors(record.error);
  return (
    <Modal title={S.shift.noSaleTitle} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {record.isError && !approvalNeeded(record.error) && Object.keys(errors).length === 0 && (
          <Notice tone="bad">{errorMessage(record.error)}</Notice>
        )}
        <Field label={S.shift.reason} error={errors.reason}>
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
        {needs && (
          <ApprovalFields
            permission={needs}
            value={approval}
            onChange={setApproval}
            errors={isApprovalError(record.error) ? errors : {}}
          />
        )}
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={record.isPending}>
            {S.shift.noSale}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}
