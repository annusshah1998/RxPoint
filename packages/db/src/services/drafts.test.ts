import { addItem, type Cart, type CartProduct } from '@app/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServiceContext, withSession } from '../context';
import { createNodeExecutor } from '../node';
import { openDatabase } from '../open';
import { asRole, createTestApp } from '../test-helpers';
import { login } from './auth';
import {
  discardDraft,
  holdDraft,
  listHeldDrafts,
  resumeDraft,
  saveDraft,
  startDraft,
} from './drafts';
import { updateStoreSettings } from './settings';

const panadol: CartProduct = {
  productId: 'p1',
  name: 'Panadol 500mg',
  units: [
    { id: 'u1', name: 'Tablet', qty: 1, isSellable: true },
    { id: 'u2', name: 'Strip', qty: 10, isSellable: true },
  ],
  price: { amount: 73500, perQty: 30 },
  allowDiscount: true,
  taxRateBp: 0,
  rx: 'none',
  schedule: null,
};

const withItem = (cart: Cart, key = 'k1') => addItem(cart, panadol, 'u2', 20, key);

describe('drafts', () => {
  it('starts one draft per till and keeps it across calls', async () => {
    const t = await createTestApp();
    const first = await startDraft(t.app);
    expect(first.cart.lines).toEqual([]);
    expect((await startDraft(t.app)).id).toBe(first.id);
    const rows = await t.db.selectFrom('sale_draft').selectAll().execute();
    expect(rows).toMatchObject([{ id: first.id, status: 'active', line_count: 0 }]);
  });

  it('saves the cart with its total and survives a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'till-'));
    const path = join(dir, 'till.db');
    const t = await createTestApp({ path });
    const draft = await startDraft(t.app);
    expect(await saveDraft(t.app, withItem(draft.cart))).toEqual({ saved: true });
    const row = await t.db.selectFrom('sale_draft').selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({ line_count: 1, total: 49000 });

    // A new connection to the same file, as after a power cut.
    const db = await openDatabase(createNodeExecutor(path));
    const ctx = createServiceContext(db, { now: t.app.now, newId: t.app.newId });
    const reopened = await startDraft(withSession(ctx, t.app.session));
    expect(reopened.id).toBe(draft.id);
    expect(reopened.cart.lines.map((l) => [l.name, l.qty])).toEqual([['Panadol 500mg', 20]]);
  });

  it('never brings back a sale that is gone', async () => {
    const t = await createTestApp();
    const draft = await startDraft(t.app);
    await saveDraft(t.app, withItem(draft.cart));
    await discardDraft(t.app, { draftId: draft.id });
    // A save that was still on its way arrives late.
    expect(await saveDraft(t.app, withItem(draft.cart))).toEqual({ saved: false });
    expect(await t.db.selectFrom('sale_draft').selectAll().execute()).toEqual([]);
    // The next cart starts cleanly.
    const next = await startDraft(t.app);
    expect(next.id).not.toBe(draft.id);
    expect(await saveDraft(t.app, withItem(next.cart))).toEqual({ saved: true });
  });

  it('logs a discarded cart that had items', async () => {
    const t = await createTestApp();
    const draft = await startDraft(t.app);
    await saveDraft(t.app, withItem(draft.cart));
    await discardDraft(t.app, { draftId: draft.id });
    const audit = await t.db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'sale.draft_discard')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(audit.before_json!)).toMatchObject({
      total: 49000,
      lines: [{ name: 'Panadol 500mg', qty: 20 }],
    });
  });

  it('holds and resumes, swapping with the sale in progress', async () => {
    const t = await createTestApp();
    const a = await startDraft(t.app);
    await saveDraft(t.app, withItem(a.cart));
    await expect(holdDraft(t.app, { draftId: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await holdDraft(t.app, { draftId: a.id, label: 'Lady in blue' });
    expect(await listHeldDrafts(t.app)).toMatchObject([
      { id: a.id, label: 'Lady in blue', lineCount: 1, total: 49000, items: ['Panadol 500mg'] },
    ]);

    // A new sale while A waits.
    const b = await startDraft(t.app);
    expect(b.id).not.toBe(a.id);
    await expect(holdDraft(t.app, { draftId: b.id })).rejects.toThrow(/nothing to hold/);
    await saveDraft(t.app, withItem(b.cart));

    // Resuming A holds B.
    const resumed = await resumeDraft(t.app, { draftId: a.id });
    expect(resumed.cart.lines).toHaveLength(1);
    expect((await startDraft(t.app)).id).toBe(a.id);
    expect((await listHeldDrafts(t.app)).map((h) => h.id)).toEqual([b.id]);

    // Resuming over an empty sale just drops the empty one.
    await holdDraft(t.app, { draftId: a.id });
    const empty = await startDraft(t.app);
    await resumeDraft(t.app, { draftId: b.id });
    const ids = (await t.db.selectFrom('sale_draft').select('id').execute()).map((r) => r.id);
    expect(ids).not.toContain(empty.id);
  });

  it('limits how many sales can be held', async () => {
    const t = await createTestApp();
    await updateStoreSettings(t.app, { maxHeld: 1 });
    const a = await startDraft(t.app);
    await saveDraft(t.app, withItem(a.cart));
    await holdDraft(t.app, { draftId: a.id });
    const b = await startDraft(t.app);
    await saveDraft(t.app, withItem(b.cart));
    await expect(holdDraft(t.app, { draftId: b.id })).rejects.toThrow(/already held/);
  });

  it('drops approvals when a sale is held, or when someone else logs in', async () => {
    const t = await createTestApp();
    const cashier = await asRole(t, 'cashier');
    const pharmacist = await asRole(t, 'pharmacist');
    const draft = await startDraft(cashier.app);
    await saveDraft(cashier.app, withItem(draft.cart));
    const grant = (id: string) =>
      t.db
        .insertInto('draft_approval')
        .values({
          id,
          draft_id: draft.id,
          kind: 'sale.controlled',
          line_key: '',
          scope_json: '{}',
          approved_bp: null,
          requested_by: cashier.id,
          approver_id: pharmacist.id,
          created_at: '2026-10-21T09:00:00.000Z',
        })
        .execute();

    await grant('g1');
    await login(t.ctx, { userId: cashier.id, pin: cashier.pin });
    expect(await t.db.selectFrom('draft_approval').selectAll().execute()).toHaveLength(1);
    await login(t.ctx, { userId: pharmacist.id, pin: pharmacist.pin });
    expect(await t.db.selectFrom('draft_approval').selectAll().execute()).toHaveLength(0);

    await grant('g2');
    await holdDraft(cashier.app, { draftId: draft.id });
    expect(await t.db.selectFrom('draft_approval').selectAll().execute()).toHaveLength(0);
  });

  it('sets aside a cart it can’t read', async () => {
    const t = await createTestApp();
    const draft = await startDraft(t.app);
    await t.db
      .updateTable('sale_draft')
      .set({ cart_json: '{"version":99}', line_count: 1 })
      .where('id', '=', draft.id)
      .execute();
    const next = await startDraft(t.app);
    expect(next.id).not.toBe(draft.id);
    expect(next.notice).toMatch(/set aside/);
    expect((await listHeldDrafts(t.app))[0]).toMatchObject({ id: draft.id, items: [] });
  });
});
