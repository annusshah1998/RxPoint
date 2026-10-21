import { formatMoney, isAppError, localTime, toMajorString } from '@app/core';
import {
  CASH_CATEGORIES,
  closeShift,
  getOpenShift,
  getShiftTotals,
  getSuggestedFloat,
  openShift,
  recordCashMovement,
  recordNoSale,
  type OpenShift,
  type ShiftTotals,
} from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useAction, useServices } from '../../app/services';
import { approvalNeeded, errorMessage, fieldErrors, isApprovalError } from '../../lib/errors';
import { readMoney } from '../../lib/money-input';
import { S } from '../../strings';
import {
  Button,
  Card,
  Field,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Select,
  TextInput,
} from '../../ui';
import { ApprovalFields, type ApprovalValue } from '../auth/ApprovalFields';
import {
  CashCountFields,
  countSum,
  emptyCount,
  toCashCount,
  type CountState,
} from './CashCountFields';
import { ShiftReport } from './ShiftReport';

type Dialog = 'pay_in' | 'pay_out' | 'no_sale' | 'close' | null;

export function ShiftScreen() {
  const { ctx } = useServices();
  const shift = useQuery({ queryKey: ['shift'], queryFn: () => getOpenShift(ctx) });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [closed, setClosed] = useState<ShiftTotals | null>(null);

  if (shift.isPending) return <Loading />;
  if (closed && !shift.data) {
    return (
      <div className="page">
        <PageHeader
          title={S.shift.closed(closed.shift.shiftNo)}
          subtitle={closed.shift.businessDate}
          actions={
            <Button variant="primary" onClick={() => setClosed(null)}>
              {S.shift.openNew}
            </Button>
          }
        />
        <Card title={S.shift.report}>
          <ShiftReport totals={closed} />
        </Card>
      </div>
    );
  }
  if (!shift.data) return <OpenShiftPanel />;

  const open = shift.data;
  return (
    <div className="page">
      <PageHeader
        title={S.shift.current(open.shiftNo)}
        subtitle={S.shift.openedBy(open.openedBy, localTime(new Date(open.openedAt), ctx.timeZone))}
        actions={
          <>
            <Button onClick={() => setDialog('pay_in')}>{S.shift.payIn}</Button>
            <Button onClick={() => setDialog('pay_out')}>{S.shift.payOut}</Button>
            <Button onClick={() => setDialog('no_sale')}>{S.shift.noSale}</Button>
            <Button variant="primary" onClick={() => setDialog('close')}>
              {S.shift.close}
            </Button>
          </>
        }
      />
      {open.stale && <Notice tone="warn">{S.shift.stale}</Notice>}
      <ShiftSoFar shiftId={open.id} />
      {(dialog === 'pay_in' || dialog === 'pay_out') && (
        <CashMovementDialog kind={dialog} onClose={() => setDialog(null)} />
      )}
      {dialog === 'no_sale' && <NoSaleDialog onClose={() => setDialog(null)} />}
      {dialog === 'close' && (
        <CloseShiftDialog
          shift={open}
          onClose={() => setDialog(null)}
          onClosed={(totals) => {
            setDialog(null);
            setClosed(totals);
          }}
        />
      )}
    </div>
  );
}

function ShiftSoFar({ shiftId }: { shiftId: string }) {
  const { ctx } = useServices();
  const totals = useQuery({
    queryKey: ['shift-totals', shiftId],
    queryFn: () => getShiftTotals(ctx, shiftId),
  });
  if (totals.isError) return <Notice tone="bad">{errorMessage(totals.error)}</Notice>;
  if (!totals.data) return <Loading />;
  return (
    <Card title={S.shift.reportX}>
      <ShiftReport totals={totals.data} />
    </Card>
  );
}

function OpenShiftPanel() {
  const { ctx } = useServices();
  const suggested = useQuery({
    queryKey: ['suggested-float'],
    queryFn: () => getSuggestedFloat(ctx),
  });
  const [floatText, setFloatText] = useState<string | null>(null);
  const [counting, setCounting] = useState(false);
  const [count, setCount] = useState<CountState>(emptyCount());
  const [floatError, setFloatError] = useState<string>();
  const [confirm, setConfirm] = useState<{ message: string; date: string } | null>(null);
  const open = useAction(openShift, {
    onSuccess: () => setConfirm(null),
  });
  const text = floatText ?? (suggested.data === undefined ? '' : toMajorString(suggested.data));

  function submit(e?: FormEvent, confirmDate?: string) {
    e?.preventDefault();
    const cashCount = counting ? toCashCount(count) : null;
    const amount = counting ? { value: countSum(cashCount) } : readMoney(text);
    if ('error' in amount || amount.value === null) {
      setFloatError('error' in amount ? amount.error : S.validation.badPrice);
      return;
    }
    setFloatError(undefined);
    open.mutate(
      { openingFloat: amount.value, count: cashCount, confirmDate },
      {
        onError: (error) => {
          if (isAppError(error) && error.code === 'NEEDS_CONFIRMATION') {
            setConfirm({ message: error.message, date: String(error.details.date) });
          }
        },
      },
    );
  }

  const errors = fieldErrors(open.error);
  const showError =
    open.isError && !(isAppError(open.error) && open.error.code === 'NEEDS_CONFIRMATION');
  return (
    <div className="page">
      <PageHeader title={S.shift.noShift} subtitle={S.shift.noShiftIntro} />
      <Card title={S.shift.openTitle} className="narrow-card">
        <form onSubmit={submit} noValidate>
          {showError && Object.keys(errors).length === 0 && (
            <Notice tone="bad">{errorMessage(open.error)}</Notice>
          )}
          {counting ? (
            <CashCountFields value={count} onChange={setCount} />
          ) : (
            <Field
              label={S.shift.openingFloat}
              hint={S.shift.openingFloatHint}
              error={floatError ?? errors.openingFloat}
            >
              <TextInput
                value={text}
                onChange={(e) => setFloatText(e.target.value)}
                inputMode="decimal"
                autoFocus
              />
            </Field>
          )}
          {counting && (floatError ?? errors.openingFloat) && (
            <Notice tone="bad">{floatError ?? errors.openingFloat}</Notice>
          )}
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={open.isPending}>
              {S.shift.open}
            </Button>
            <Button variant="ghost" onClick={() => setCounting((c) => !c)}>
              {counting ? S.shift.hideCount : S.shift.countNotes}
            </Button>
          </div>
        </form>
      </Card>
      {confirm && (
        <Modal title={S.shift.confirmDateTitle} onClose={() => setConfirm(null)}>
          <p>{confirm.message}</p>
          <div className="form-actions">
            <Button variant="primary" onClick={() => submit(undefined, confirm.date)}>
              {S.shift.confirmDate(confirm.date)}
            </Button>
            <Button onClick={() => setConfirm(null)}>{S.common.cancel}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const noApproval: ApprovalValue = { userId: '', pin: '' };

function CashMovementDialog({
  kind,
  onClose,
}: {
  kind: 'pay_in' | 'pay_out';
  onClose: () => void;
}) {
  const [values, setValues] = useState({
    category: kind === 'pay_in' ? 'change' : 'expense',
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

  const errors = fieldErrors(record.error);
  const approvalErrors = isApprovalError(record.error) ? errors : {};
  return (
    <Modal title={kind === 'pay_in' ? S.shift.payInTitle : S.shift.payOutTitle} onClose={onClose}>
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

function NoSaleDialog({ onClose }: { onClose: () => void }) {
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

function CloseShiftDialog({
  shift,
  onClose,
  onClosed,
}: {
  shift: OpenShift;
  onClose: () => void;
  onClosed: (totals: ShiftTotals) => void;
}) {
  const [count, setCount] = useState<CountState>(emptyCount());
  const [floatText, setFloatText] = useState(toMajorString(shift.openingFloat));
  const [note, setNote] = useState('');
  const [variance, setVariance] = useState<number | null>(null);
  const [localError, setLocalError] = useState<string>();
  const close = useAction(closeShift, {
    onSuccess: (result) => {
      if (result.status === 'needs_note') setVariance(result.variance);
      else onClosed(result.totals);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const cashCount = toCashCount(count);
    const counted = countSum(cashCount);
    const floatLeft = readMoney(floatText);
    if (counted === null || 'error' in floatLeft || floatLeft.value === null) {
      setLocalError(S.validation.badPrice);
      return;
    }
    setLocalError(undefined);
    close.mutate({
      shiftId: shift.id,
      countedCash: counted,
      count: cashCount,
      floatLeft: floatLeft.value,
      note: note || null,
    });
  }

  const errors = fieldErrors(close.error);
  return (
    <Modal title={S.shift.closeTitle} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="muted">{S.shift.closeIntro}</p>
        {(localError ?? (close.isError && Object.keys(errors).length === 0)) && (
          <Notice tone="bad">{localError ?? errorMessage(close.error)}</Notice>
        )}
        {errors.countedCash && <Notice tone="bad">{errors.countedCash}</Notice>}
        <CashCountFields value={count} onChange={setCount} />
        <Field label={S.shift.floatLeft} error={errors.floatLeft}>
          <TextInput
            value={floatText}
            onChange={(e) => setFloatText(e.target.value)}
            inputMode="decimal"
          />
        </Field>
        {variance !== null && (
          <Notice tone="warn">
            {variance < 0
              ? S.shift.varianceShort(formatMoney(-variance))
              : S.shift.varianceOver(formatMoney(variance))}
          </Notice>
        )}
        {(variance !== null || note) && (
          <Field label={S.shift.closeNote}>
            <TextInput value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          </Field>
        )}
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={close.isPending}>
            {S.shift.closeNow}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}
