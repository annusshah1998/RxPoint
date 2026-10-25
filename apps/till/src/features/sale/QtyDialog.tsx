import { displayQty, lineQtyProblem, looksLikeBarcode, parseQtyInput, setQty } from '@app/core';
import { useState, type FormEvent } from 'react';
import { S } from '../../strings';
import { Button, Field, Modal, TextInput } from '../../ui';
import type { SaleState } from './use-sale';
import { useScanGuard } from './use-scan-guard';

/**
 * Enter on an empty scan box: the selected line's quantity, typed the quick way ("3" of the
 * line's unit, "2s", "1b 2t"). A barcode scanned or typed here adds that item instead and
 * leaves this line as it was.
 */
export function QtyDialog({
  sale,
  lineKey,
  onScan,
  onClose,
}: {
  sale: SaleState;
  lineKey: string;
  onScan: (code: string) => void;
  onClose: () => void;
}) {
  const line = sale.cart!.lines.find((l) => l.key === lineKey);
  const [text, setText] = useState(line ? displayQty(line) : '');
  const [error, setError] = useState<string>();

  useScanGuard((code) => {
    onScan(code);
    return true;
  });

  if (!line) return null;
  const sellable = line.units.filter((u) => u.isSellable);
  const unit = line.units.find((u) => u.id === line.unitId) ?? sellable[0] ?? line.units[0]!;
  const parsed = looksLikeBarcode(text) ? null : parseQtyInput(text, sellable, unit);
  // "2s" makes Strips the line's unit; "1b 2t" keeps the unit it had.
  const unitId = parsed?.ok && parsed.parts.length === 1 ? parsed.parts[0]!.unit.id : unit.id;
  const preview =
    parsed?.ok && !lineQtyProblem(parsed.baseQty)
      ? S.sale.qtyPreview(displayQty({ qty: parsed.baseQty, units: line.units, unitId }))
      : S.sale.qtyHint;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!line) return;
    // However slowly it was typed, a barcode here is a scan, never a quantity.
    if (looksLikeBarcode(text)) {
      onScan(text.trim());
      return;
    }
    if (!parsed?.ok) {
      setError(S.sale.badQty);
      return;
    }
    if (lineQtyProblem(parsed.baseQty)) {
      setError(S.sale.tooMany);
      return;
    }
    if (!sale.update((c) => setQty(c, line.key, parsed.baseQty, unitId))) {
      setError(S.sale.tooMany);
      return;
    }
    onClose();
  }

  return (
    <Modal title={S.sale.qtyTitle(line.name)} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <Field label={S.sale.qtyInput} hint={preview} error={error}>
          <TextInput
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(undefined);
            }}
            onFocus={(e) => e.target.select()}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
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
