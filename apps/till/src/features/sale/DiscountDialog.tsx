import {
  formatMoney,
  parseDiscountInput,
  priceForQty,
  setBillDiscount,
  setLineDiscount,
  type DiscountSpec,
} from '@app/core';
import { useState, type FormEvent } from 'react';
import { S } from '../../strings';
import { Button, Field, Modal, TextInput } from '../../ui';
import type { SaleState } from './use-sale';

function specText(spec: DiscountSpec | 'default' | 'none' | null): string {
  if (!spec || spec === 'default' || spec === 'none') return '';
  return spec.kind === 'percent' ? String(spec.bp / 100) : `${spec.amount / 100}/-`;
}

/** F6 (the selected line) or Shift+F6 (the whole bill): "10" is 10%, "50/-" is Rs 50 off. */
export function DiscountDialog({
  sale,
  lineKey,
  capBp,
  onClose,
}: {
  sale: SaleState;
  lineKey: string | null;
  capBp: number | null;
  onClose: () => void;
}) {
  const cart = sale.cart!;
  const line = lineKey ? cart.lines.find((l) => l.key === lineKey) : undefined;
  const [text, setText] = useState(specText(line ? line.discount : cart.billDiscount));
  const [error, setError] = useState<string>();
  const parsed = parseDiscountInput(text);
  const base = line ? priceForQty(line.price, line.qty) : (sale.plan?.totals?.grossTotal ?? 0);
  const off =
    parsed.kind === 'percent'
      ? Math.round((base * parsed.bp) / 10_000)
      : parsed.kind === 'amount'
        ? parsed.amount
        : 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (parsed.kind === 'invalid') {
      setError(S.sale.discountBad);
      return;
    }
    const spec: DiscountSpec | null =
      parsed.kind === 'none'
        ? null
        : parsed.kind === 'percent'
          ? { kind: 'percent', bp: parsed.bp }
          : { kind: 'amount', amount: parsed.amount };
    const ok = sale.update((c) =>
      line ? setLineDiscount(c, line.key, spec ?? 'default') : setBillDiscount(c, spec),
    );
    if (!ok) {
      setError(S.sale.discountBad);
      return;
    }
    onClose();
  }

  return (
    <Modal
      title={line ? S.sale.discountTitleLine(line.name) : S.sale.discountTitleBill}
      onClose={onClose}
    >
      <form onSubmit={submit} noValidate>
        <Field
          label={S.sale.discountInput}
          hint={
            off > 0
              ? `−${formatMoney(off, { symbol: false })} → ${formatMoney(Math.max(base - off, 0), { symbol: false })}`
              : S.sale.discountHint
          }
          error={error}
        >
          <TextInput value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
        {capBp !== null && <p className="muted">{S.sale.yourLimit(`${capBp / 100}%`)}</p>}
        <div className="form-actions">
          <Button type="submit" variant="primary">
            {S.sale.apply}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}
