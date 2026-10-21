import { formatExpiry, parseExpiry, parseMoney, toMajorString } from '@app/core';
import { addOpeningStock, type OpeningStockInput, type ProductDetail } from '@app/db';
import { useRef, useState, type FormEvent } from 'react';
import { useAction } from '../../app/services';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { unitLabel } from '../../lib/format';
import { S } from '../../strings';
import { Button, Card, Field, Notice, TextInput } from '../../ui';
import { readQty } from './qty-field';

export function OpeningStockForm({ product }: { product: ProductDetail }) {
  const priceUnit = unitLabel(product.units, product.priceQty);
  const initial = {
    batchNo: '',
    expiry: '',
    qty: '',
    cost: product.costPrice === null ? '' : toMajorString(product.costPrice),
    mrp: toMajorString(product.salePrice),
  };
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<{ warnings: string[] } | null>(null);
  const batchRef = useRef<HTMLInputElement>(null);

  const add = useAction(addOpeningStock, {
    onSuccess: (result) => {
      setAdded({ warnings: result.warnings });
      setValues((v) => ({ ...v, batchNo: '', expiry: '', qty: '' }));
      batchRef.current?.focus();
    },
  });

  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  const expiry = values.expiry.trim() ? parseExpiry(values.expiry) : null;
  const qty = values.qty.trim() ? readQty(values.qty, product.units) : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    setAdded(null);
    const problems: Record<string, string> = {};
    if (values.expiry.trim() && !expiry) problems.expiryDate = S.validation.badDate;
    if (!qty) problems.qty = S.validation.enterQuantity;
    else if ('error' in qty) problems.qty = qty.error;
    const cost = values.cost.trim() ? parseMoney(values.cost) : null;
    if (values.cost.trim() && cost === null) problems.costPrice = S.validation.badPrice;
    const mrp = values.mrp.trim() ? parseMoney(values.mrp) : null;
    if (values.mrp.trim() && mrp === null) problems.mrp = S.validation.badPrice;
    setErrors(problems);
    if (Object.keys(problems).length > 0 || !qty || 'error' in qty) return;

    const input: OpeningStockInput = {
      productId: product.id,
      batchNo: values.batchNo,
      expiryDate: expiry,
      qty: qty.baseQty,
      costPrice: cost,
      mrp,
      packQty: product.priceQty,
    };
    add.mutate(input);
  }

  const shown = { ...fieldErrors(add.error), ...errors };

  return (
    <Card title={S.opening.title}>
      <form onSubmit={submit} noValidate>
        <p className="muted">{S.opening.intro}</p>
        {add.isError && <Notice tone="bad">{errorMessage(add.error)}</Notice>}
        {added && (
          <Notice tone={added.warnings.length ? 'warn' : 'good'}>
            {S.opening.added}
            {added.warnings.length > 0 && `: ${added.warnings.join('; ')}`}
          </Notice>
        )}
        <div className="row">
          <Field label={S.opening.batchNo} error={shown.batchNo}>
            <TextInput ref={batchRef} value={values.batchNo} onChange={set('batchNo')} />
          </Field>
          <Field
            label={S.opening.expiry}
            error={shown.expiryDate}
            hint={expiry ? formatExpiry(expiry) : S.opening.expiryHint}
          >
            <TextInput value={values.expiry} onChange={set('expiry')} placeholder="MM/YYYY" />
          </Field>
          <Field
            label={S.opening.qty}
            error={shown.qty}
            hint={qty && 'preview' in qty ? `= ${qty.preview}` : S.opening.qtyHint}
          >
            <TextInput value={values.qty} onChange={set('qty')} />
          </Field>
        </div>
        <div className="row">
          <Field label={S.opening.cost(priceUnit)} error={shown.costPrice}>
            <TextInput value={values.cost} onChange={set('cost')} inputMode="decimal" />
          </Field>
          <Field label={S.opening.mrp(priceUnit)} error={shown.mrp}>
            <TextInput value={values.mrp} onChange={set('mrp')} inputMode="decimal" />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {S.opening.submit}
        </Button>
      </form>
    </Card>
  );
}
