import { formatQty } from '@app/core';
import { adjustStock, type BatchStock, type ProductDetail } from '@app/db';
import { useState, type FormEvent } from 'react';
import { useAction } from '../../app/services';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Field, Modal, Notice, Select, TextInput } from '../../ui';
import { readQty } from './qty-field';

export function AdjustStockDialog({
  product,
  batch,
  onClose,
}: {
  product: ProductDetail;
  batch: BatchStock;
  onClose: () => void;
}) {
  const [direction, setDirection] = useState<'remove' | 'add'>('remove');
  const [qtyText, setQtyText] = useState('');
  const [reason, setReason] = useState('');
  const [qtyError, setQtyError] = useState<string>();
  const adjust = useAction(adjustStock, { onSuccess: onClose });
  const qty = qtyText.trim() ? readQty(qtyText, product.units) : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!qty || 'error' in qty) {
      setQtyError(qty && 'error' in qty ? qty.error : S.validation.enterQuantity);
      return;
    }
    setQtyError(undefined);
    adjust.mutate({
      batchId: batch.batchId,
      qtyDelta: direction === 'add' ? qty.baseQty : -qty.baseQty,
      reason,
    });
  }

  const errors = fieldErrors(adjust.error);
  return (
    <Modal title={S.adjust.title} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <p className="muted">
          {S.detail.batch} {batch.batchNo || S.detail.noBatch} · {S.adjust.current}:{' '}
          {formatQty(batch.qty, product.units)}
        </p>
        {adjust.isError && <Notice tone="bad">{errorMessage(adjust.error)}</Notice>}
        <div className="row">
          <Field label={S.adjust.direction}>
            <Select
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'add' | 'remove')}
            >
              <option value="remove">{S.adjust.removeStock}</option>
              <option value="add">{S.adjust.addStock}</option>
            </Select>
          </Field>
          <Field
            label={S.adjust.qty}
            error={qtyError ?? errors.qtyDelta}
            hint={qty && 'preview' in qty ? `= ${qty.preview}` : S.opening.qtyHint}
          >
            <TextInput value={qtyText} onChange={(e) => setQtyText(e.target.value)} />
          </Field>
        </div>
        <Field label={S.adjust.reason} hint={S.adjust.reasonHint} error={errors.reason}>
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={adjust.isPending}>
            {S.adjust.submit}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}
