import { CASH_CATEGORIES, getDeviceSettings, recordCashMovement, recordNoSale } from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useAction, useServices } from '../../app/services';
import { approvalNeeded, errorMessage, fieldErrors, isApprovalError } from '../../lib/errors';
import { readMoney } from '../../lib/money-input';
import { S } from '../../strings';
import { Button, Field, Modal, Notice, Select, TextInput } from '../../ui';
import { drawerWorks } from '../../platform/printer';
import { ApprovalFields, type ApprovalValue } from '../auth/ApprovalFields';
import { usePrinting } from '../printing/printing';

type CashKind = 'pay_in' | 'pay_out';

const noApproval: ApprovalValue = { userId: '', pin: '' };
const defaultCategory = (kind: CashKind) => (kind === 'pay_in' ? 'change' : 'expense');

/**
 * Opens the drawer through the printer once the cash movement or no-sale is saved, when
 * this till has one set up. It runs in the background: a failure shows in the printer
 * problems bar with Retry, and never undoes what was recorded.
 */
function useKickDrawer() {
  const printing = usePrinting();
  return () =>
    void printing
      .settings()
      .then((settings) => printing.openDrawer(settings))
      .catch(console.error);
}

/** Whether the drawer opens by itself here; otherwise staff open it by hand. */
function useDrawerWorks(): boolean {
  const { ctx } = useServices();
  const device = useQuery({ queryKey: ['device-settings'], queryFn: () => getDeviceSettings(ctx) });
  return device.data ? drawerWorks(device.data) : false;
}

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
  const kick = useKickDrawer();
  const record = useAction(recordCashMovement, {
    onSuccess: () => {
      kick();
      onClose();
    },
  });
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

/**
 * Opens the drawer without a sale (Alt+D): the reason, and a PIN when needed, are logged
 * first (`drawer.no_sale`); then the drawer opens through the printer, or by hand when
 * none is set up.
 */
export function NoSaleDialog({ onClose }: { onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState<ApprovalValue>(noApproval);
  const [needs, setNeeds] = useState<ReturnType<typeof approvalNeeded>>(null);
  const kick = useKickDrawer();
  const works = useDrawerWorks();
  const record = useAction(recordNoSale, {
    onSuccess: () => {
      kick();
      onClose();
    },
  });

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
        {!works && <p className="muted">{S.shift.noSaleByHand}</p>}
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
