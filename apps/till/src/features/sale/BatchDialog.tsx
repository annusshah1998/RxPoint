import {
  formatExpiry,
  formatMoney,
  formatQty,
  parseExpiry,
  parseMoney,
  pickBatches,
  setPackBatch,
  toMajorString,
} from '@app/core';
import { getSellable, today } from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useServices } from '../../app/services';
import { EXPIRY_LABEL, EXPIRY_TONE } from '../../lib/format';
import { S } from '../../strings';
import { Badge, Button, Field, Loading, Modal, Notice, TextInput } from '../../ui';
import type { SaleState } from './use-sale';

/**
 * F4: which batch the selected line takes stock from. Automatic means first to expire.
 * A controlled drug must name the batch on the pack; if it isn't on record, it is typed in.
 */
export function BatchDialog({
  sale,
  lineKey,
  onClose,
}: {
  sale: SaleState;
  lineKey: string;
  onClose: () => void;
}) {
  const { ctx } = useServices();
  const line = sale.cart!.lines.find((l) => l.key === lineKey)!;
  const item = useQuery({
    queryKey: ['sellable', line.productId],
    queryFn: () => getSellable(ctx, line.productId),
  });
  const controlled = line.rx === 'controlled';
  const [typed, setTyped] = useState({
    batchNo: line.packBatch?.batchNo ?? '',
    expiry: line.packBatch ? formatExpiry(line.packBatch.expiryDate) : '',
    mrp: line.packBatch?.mrp != null ? toMajorString(line.packBatch.mrp) : '',
  });
  const [errors, setErrors] = useState<{ batchNo?: string; expiry?: string; mrp?: string }>({});

  function pick(batchId: string | null) {
    sale.update((c) => pickBatches(c, lineKey, batchId ? [{ batchId, qty: line.qty }] : null));
    onClose();
  }

  function applyTyped(e: FormEvent) {
    e.preventDefault();
    const batchNo = typed.batchNo.trim();
    const expiryDate = parseExpiry(typed.expiry);
    const mrp = typed.mrp.trim() ? parseMoney(typed.mrp) : null;
    const found: typeof errors = {};
    if (!batchNo) found.batchNo = S.batches.needBatchNo;
    if (!expiryDate) found.expiry = S.batches.badExpiry;
    else if (expiryDate < today(ctx)) found.expiry = S.batches.expiredPack;
    if (typed.mrp.trim() && mrp === null) found.mrp = S.validation.badPrice;
    setErrors(found);
    if (Object.keys(found).length > 0 || !expiryDate) return;
    sale.update((c) => setPackBatch(c, lineKey, { batchNo, expiryDate, mrp }));
    onClose();
  }

  const q = (n: number) => formatQty(Math.max(n, 0), line.units);
  return (
    <Modal title={S.batches.title(line.name)} onClose={onClose}>
      {controlled && <Notice tone="warn">{S.batches.controlledNote}</Notice>}
      {!item.data ? (
        <Loading />
      ) : (
        <ul className="batch-list">
          {!controlled && (
            <li>
              <Button
                variant={line.batches === null && !line.packBatch ? 'primary' : 'secondary'}
                onClick={() => pick(null)}
                autoFocus
              >
                {S.batches.automatic}
              </Button>
            </li>
          )}
          {item.data.batches
            .filter((b) => !(controlled && b.placeholder))
            .map((b) => {
              const expired = b.status === 'expired';
              const chosen = line.batches?.some((x) => x.batchId === b.batchId);
              return (
                <li key={b.batchId}>
                  <Button
                    variant={chosen ? 'primary' : 'secondary'}
                    disabled={expired}
                    onClick={() => pick(b.batchId)}
                    className="batch-row"
                  >
                    <span className="batch-no">
                      {b.placeholder ? S.batches.unrecorded : b.batchNo || S.batches.noNumber}
                    </span>
                    {b.expiryDate && (
                      <Badge tone={EXPIRY_TONE[b.status]}>
                        {expired ? S.batches.expired : EXPIRY_LABEL[b.status]}{' '}
                        {formatExpiry(b.expiryDate)}
                      </Badge>
                    )}
                    <span>
                      {S.batches.onHand}: {q(b.qty)}
                    </span>
                    {b.mrp && (
                      <span>
                        {S.batches.mrp} {formatMoney(b.mrp.amount)}
                      </span>
                    )}
                  </Button>
                  {!expired && !b.placeholder && b.qty < line.qty && (
                    <div className="muted">{S.batches.shortStock(q(b.qty))}</div>
                  )}
                </li>
              );
            })}
        </ul>
      )}
      {controlled && (
        <form onSubmit={applyTyped} noValidate>
          <h3 className="form-section">{S.batches.typeTitle}</h3>
          <div className="row">
            <Field label={S.batches.typeBatchNo} error={errors.batchNo}>
              <TextInput
                value={typed.batchNo}
                onChange={(e) => setTyped((t) => ({ ...t, batchNo: e.target.value }))}
              />
            </Field>
            <Field label={S.batches.typeExpiry} error={errors.expiry}>
              <TextInput
                value={typed.expiry}
                placeholder="03/2027"
                onChange={(e) => setTyped((t) => ({ ...t, expiry: e.target.value }))}
              />
            </Field>
            <Field label={S.batches.typeMrp} error={errors.mrp}>
              <TextInput
                value={typed.mrp}
                inputMode="decimal"
                onChange={(e) => setTyped((t) => ({ ...t, mrp: e.target.value }))}
              />
            </Field>
          </div>
          <Button type="submit">{S.batches.useTyped}</Button>
        </form>
      )}
    </Modal>
  );
}
