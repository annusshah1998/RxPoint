import { formatMoney, localTime } from '@app/core';
import { discardDraft, holdDraft, listHeldDrafts, resumeDraft, startDraft } from '@app/db';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useServices } from '../../app/services';
import { errorMessage } from '../../lib/errors';
import { S } from '../../strings';
import { Button, EmptyState, Field, Modal, Notice, TextInput } from '../../ui';
import type { SaleState } from './use-sale';

/** F8: set the sale aside with an optional note, and start a new one. */
export function HoldDialog({ sale, onClose }: { sale: SaleState; onClose: () => void }) {
  const { ctx } = useServices();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await sale.flush();
      await holdDraft(ctx, { draftId: sale.cart!.id, label });
      sale.replace((await startDraft(ctx)).cart);
      await queryClient.invalidateQueries();
      onClose();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal title={S.sale.holdTitle} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {error != null && <Notice tone="bad">{errorMessage(error)}</Notice>}
        <Field label={S.sale.holdLabel} hint={S.sale.holdHint}>
          <TextInput value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </Field>
        <div className="form-actions">
          <Button type="submit" variant="primary">
            {S.sale.hold}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Shift+F8: held sales. Resuming holds the sale in progress first. */
export function HeldDialog({ sale, onClose }: { sale: SaleState; onClose: () => void }) {
  const { ctx } = useServices();
  const queryClient = useQueryClient();
  const held = useQuery({ queryKey: ['held'], queryFn: () => listHeldDrafts(ctx) });
  const [error, setError] = useState<unknown>(null);

  async function resume(id: string) {
    try {
      await sale.flush();
      const draft = await resumeDraft(ctx, { draftId: id });
      sale.replace(draft.cart);
      await queryClient.invalidateQueries();
      onClose();
    } catch (err) {
      setError(err);
    }
  }

  async function discard(id: string) {
    if (!window.confirm(S.sale.discardConfirm)) return;
    try {
      await discardDraft(ctx, { draftId: id });
      await held.refetch();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Modal title={S.sale.held} onClose={onClose}>
      {error != null && <Notice tone="bad">{errorMessage(error)}</Notice>}
      {held.data?.length === 0 && <EmptyState>{S.sale.heldEmpty}</EmptyState>}
      <ul className="held-list">
        {held.data?.map((h, i) => (
          <li key={h.id}>
            <div>
              <strong>{h.label || h.items.join(', ') || '—'}</strong>
              <div className="muted">
                {S.sale.lines(h.lineCount)} · {formatMoney(h.total)} ·{' '}
                {S.sale.heldBy(h.heldBy, localTime(new Date(h.heldAt), ctx.timeZone))}
              </div>
            </div>
            <div className="cell-actions">
              <Button
                variant="primary"
                size="small"
                autoFocus={i === 0}
                onClick={() => void resume(h.id)}
              >
                {S.sale.resume}
              </Button>
              <Button size="small" variant="ghost" onClick={() => void discard(h.id)}>
                {S.sale.discard}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
