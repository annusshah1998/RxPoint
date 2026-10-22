import type { Cart } from '@app/core';
import { planSale, saveDraft, startDraft } from '@app/db';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServices } from '../../app/services';
import { useDebounced } from '../../lib/use-debounced';

export type SaveState = 'saved' | 'saving' | 'failed';

/**
 * The cart being rung up. Every change is saved to the local draft within 150 ms (not
 * through useAction: a scan shouldn't refresh every query), and priced by the service a
 * moment later for totals and warnings. `flush()` saves at once; call it before Pay, hold,
 * approvals and locking.
 */
export function useSale() {
  const { ctx } = useServices();
  const [cart, setCart] = useState<Cart | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const pending = useRef<Cart | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    const draft = await startDraft(ctx);
    pending.current = null;
    setCart(draft.cart);
    setNotice(draft.notice ?? (draft.cart.lines.length > 0 ? 'restored' : null));
  }, [ctx]);

  useEffect(() => {
    void load();
  }, [load]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    pending.current = null;
    if (next) {
      setSaveState('saving');
      saving.current = saving.current.then(async () => {
        try {
          await saveDraft(ctx, next);
          setSaveState('saved');
        } catch (error) {
          console.error(error);
          setSaveState('failed');
        }
      });
    }
    await saving.current;
  }, [ctx]);

  /** Applies a change to the cart and schedules the save. Returns false if it threw. */
  const update = useCallback(
    (change: (cart: Cart) => Cart): boolean => {
      if (!cart) return false;
      let next: Cart;
      try {
        next = change(cart);
      } catch (error) {
        console.warn(error);
        return false;
      }
      if (next === cart) return true;
      setCart(next);
      pending.current = next;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void flush(), 150);
      return true;
    },
    [cart, flush],
  );

  // Save whatever is pending if the screen goes away (route change, lock).
  useEffect(() => () => void flush(), [flush]);

  /** Replaces the cart after a service changed the draft (complete, hold, resume, discard). */
  const replace = useCallback((next: Cart) => {
    window.clearTimeout(timer.current);
    pending.current = null;
    setCart(next);
  }, []);

  const priced = useDebounced(cart, 120);
  const plan = useQuery({
    queryKey: ['plan', priced],
    queryFn: () => planSale(ctx, priced!),
    enabled: !!priced && priced.lines.length > 0,
    placeholderData: keepPreviousData,
  });

  return {
    cart,
    update,
    replace,
    flush,
    reload: load,
    saveState,
    notice,
    clearNotice: () => setNotice(null),
    plan: cart && cart.lines.length > 0 ? plan.data : undefined,
    planFresh: priced === cart && !plan.isFetching,
    refreshPlan: () => plan.refetch(),
  };
}

export type SaleState = ReturnType<typeof useSale>;
