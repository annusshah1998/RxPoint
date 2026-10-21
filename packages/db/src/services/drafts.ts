import { AppError, newCart, normalizeCart, priceSale, toPricingLines, type Cart } from '@app/core';
import { z } from 'zod';
import { timestamp, type AppContext } from '../context';
import { audit } from '../writes';
import { actorTx } from './guards';
import { getStoreSettingsTx } from './settings';

/*
 * The sale being rung up lives in a local sale_draft row from the moment the cart starts,
 * so a crash, reload or power cut loses at most the last fraction of a second of typing.
 * Saves only UPDATE the row: once the sale is completed (or discarded) the row is gone and
 * a late save changes nothing. Completing a sale uses the draft's id as the sale's id.
 */

const money = z.number().int().min(0);
const packPrice = z.object({ amount: money, perQty: z.number().int().min(1) });
const discountSpec = z.union([
  z.object({ kind: z.literal('percent'), bp: z.number().int().min(0).max(10_000) }),
  z.object({ kind: z.literal('amount'), amount: money }),
]);
const unit = z.object({
  id: z.string(),
  name: z.string(),
  qty: z.number().int().min(1),
  isSellable: z.boolean(),
});
const line = z.object({
  key: z.string(),
  productId: z.string(),
  name: z.string(),
  units: z.array(unit).min(1),
  unitId: z.string(),
  qty: z.number().int().min(1),
  listPrice: packPrice,
  price: packPrice,
  priceSource: z.enum(['catalog', 'mrp', 'override']),
  priceReason: z.string().nullable(),
  discount: z.union([discountSpec, z.literal('default'), z.literal('none')]),
  allowDiscount: z.boolean(),
  taxRateBp: z.number().int().min(0).max(10_000),
  batches: z.array(z.object({ batchId: z.string(), qty: z.number().int().min(1) })).nullable(),
  packBatch: z
    .object({ batchNo: z.string(), expiryDate: z.string(), mrp: money.nullable() })
    .nullable(),
  rx: z.enum(['none', 'required', 'controlled']),
  schedule: z.string().nullable(),
  confirmedInDate: z.boolean(),
});
const cartSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  startedAt: z.string(),
  userId: z.string(),
  lines: z.array(line),
  selectedKey: z.string().nullable(),
  billDiscount: discountSpec.nullable(),
  rxCheck: z.enum(['seen', 'not_seen']).nullable(),
  prescription: z
    .object({
      patientName: z.string(),
      patientPhone: z.string().nullish(),
      prescriberName: z.string(),
      prescriberRegNo: z.string().nullish(),
      rxDate: z.string().nullish(),
      rxRef: z.string().nullish(),
    })
    .nullable(),
  removed: z.array(
    z.object({
      productId: z.string(),
      name: z.string(),
      qty: z.number(),
      gross: z.number(),
      at: z.string(),
      by: z.string(),
    }),
  ),
  undo: z.object({ line, index: z.number().int() }).nullable(),
});

/** Reads a stored cart, or null if it was written by another version and can't be read. */
export function parseCart(json: string): Cart | null {
  try {
    const parsed = cartSchema.safeParse(JSON.parse(json));
    return parsed.success ? (parsed.data as Cart) : null;
  } catch {
    return null;
  }
}

export interface Draft {
  id: string;
  cart: Cart;
  updatedAt: string;
}

/** The sale in progress on this till, starting an empty one if there is none. */
export async function startDraft(ctx: AppContext): Promise<Draft & { notice: string | null }> {
  return ctx.db.transaction().execute(async (trx) => {
    await actorTx(trx, ctx);
    const row = await trx
      .selectFrom('sale_draft')
      .selectAll()
      .where('device_id', '=', ctx.session.deviceId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const now = timestamp(ctx);
    let notice: string | null = null;
    if (row) {
      const cart = parseCart(row.cart_json);
      if (cart) return { id: row.id, cart, updatedAt: row.updated_at, notice };
      // Written by a different version: keep it (as held) rather than lose it.
      await trx
        .updateTable('sale_draft')
        .set({ status: 'held', held_at: now, label: 'Could not be opened' })
        .where('id', '=', row.id)
        .execute();
      notice = 'A sale from an older version was set aside in Held sales.';
    }
    const id = ctx.newId();
    const cart = newCart(id, ctx.session.userId, now);
    await trx
      .insertInto('sale_draft')
      .values({
        id,
        device_id: ctx.session.deviceId,
        user_id: ctx.session.userId,
        status: 'active',
        label: null,
        cart_json: JSON.stringify(cart),
        line_count: 0,
        total: 0,
        created_at: now,
        updated_at: now,
        held_at: null,
      })
      .execute();
    return { id, cart, updatedAt: now, notice };
  });
}

/** The cart's total for the held list; 0 if it can't be priced right now. */
async function draftTotal(ctx: AppContext, cart: Cart): Promise<number> {
  try {
    const settings = await getStoreSettingsTx(ctx.db, ctx.session.branchId);
    const normal = normalizeCart(cart, settings).cart;
    return priceSale(toPricingLines(normal), normal.billDiscount, settings).total;
  } catch {
    return 0;
  }
}

/**
 * Saves the cart in one statement. Returns `saved: false` when the draft is no longer
 * there (completed or discarded meanwhile); the screen then ignores the save.
 */
export async function saveDraft(ctx: AppContext, cart: Cart): Promise<{ saved: boolean }> {
  const total = await draftTotal(ctx, cart);
  const result = await ctx.db
    .updateTable('sale_draft')
    .set({
      cart_json: JSON.stringify(cart),
      line_count: cart.lines.length,
      total,
      updated_at: timestamp(ctx),
    })
    .where('id', '=', cart.id)
    .where('device_id', '=', ctx.session.deviceId)
    .executeTakeFirst();
  return { saved: Number(result.numUpdatedRows) > 0 };
}

export interface HeldSale {
  id: string;
  label: string | null;
  lineCount: number;
  total: number;
  heldAt: string;
  heldBy: string;
  /** First few item names, to recognise the customer's basket. */
  items: string[];
}

export async function listHeldDrafts(ctx: AppContext): Promise<HeldSale[]> {
  const rows = await ctx.db
    .selectFrom('sale_draft as d')
    .innerJoin('app_user as u', 'u.id', 'd.user_id')
    .select(['d.id', 'd.label', 'd.line_count', 'd.total', 'd.held_at', 'd.cart_json', 'u.name'])
    .where('d.device_id', '=', ctx.session.deviceId)
    .where('d.status', '=', 'held')
    .orderBy('d.held_at')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    lineCount: r.line_count,
    total: r.total,
    heldAt: r.held_at!,
    heldBy: r.name,
    items: (parseCart(r.cart_json)?.lines ?? []).slice(0, 3).map((l) => l.name),
  }));
}

const holdSchema = z.object({
  draftId: z.string().min(1),
  label: z.string().trim().max(60).nullish(),
});

/**
 * Sets the sale aside (the customer went to fetch a prescription). Approvals given for it
 * are dropped: they are asked for again when it is resumed.
 */
export async function holdDraft(ctx: AppContext, input: z.input<typeof holdSchema>): Promise<void> {
  const data = holdSchema.parse(input);
  const settings = await getStoreSettingsTx(ctx.db, ctx.session.branchId);
  await ctx.db.transaction().execute(async (trx) => {
    await actorTx(trx, ctx);
    const draft = await trx
      .selectFrom('sale_draft')
      .select(['id', 'line_count'])
      .where('id', '=', data.draftId)
      .where('device_id', '=', ctx.session.deviceId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!draft) throw new AppError('INVALID_STATE', 'This sale is no longer open');
    if (draft.line_count === 0) throw new AppError('INVALID_STATE', 'There is nothing to hold');
    const held = await trx
      .selectFrom('sale_draft')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('device_id', '=', ctx.session.deviceId)
      .where('status', '=', 'held')
      .executeTakeFirstOrThrow();
    if (Number(held.n) >= settings.maxHeld) {
      throw new AppError(
        'INVALID_STATE',
        `${settings.maxHeld} sales are already held. Finish or discard one first.`,
      );
    }
    await trx.deleteFrom('draft_approval').where('draft_id', '=', draft.id).execute();
    await trx
      .updateTable('sale_draft')
      .set({ status: 'held', held_at: timestamp(ctx), label: data.label || null })
      .where('id', '=', draft.id)
      .execute();
  });
}

/** Brings a held sale back. The sale in progress is held (or dropped if it was empty). */
export async function resumeDraft(ctx: AppContext, input: { draftId: string }): Promise<Draft> {
  return ctx.db.transaction().execute(async (trx) => {
    await actorTx(trx, ctx);
    const target = await trx
      .selectFrom('sale_draft')
      .selectAll()
      .where('id', '=', input.draftId)
      .where('device_id', '=', ctx.session.deviceId)
      .where('status', '=', 'held')
      .executeTakeFirst();
    if (!target) throw new AppError('INVALID_STATE', 'This held sale is no longer there');
    const cart = parseCart(target.cart_json);
    if (!cart) throw new AppError('INVALID_STATE', 'This held sale can’t be opened');

    const current = await trx
      .selectFrom('sale_draft')
      .select(['id', 'line_count'])
      .where('device_id', '=', ctx.session.deviceId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    const now = timestamp(ctx);
    if (current) {
      await trx.deleteFrom('draft_approval').where('draft_id', '=', current.id).execute();
      if (current.line_count > 0) {
        await trx
          .updateTable('sale_draft')
          .set({ status: 'held', held_at: now })
          .where('id', '=', current.id)
          .execute();
      } else {
        await trx.deleteFrom('sale_draft').where('id', '=', current.id).execute();
      }
    }
    await trx
      .updateTable('sale_draft')
      .set({ status: 'active', held_at: null, updated_at: now })
      .where('id', '=', target.id)
      .execute();
    return { id: target.id, cart, updatedAt: now };
  });
}

/** Throws the sale in progress away. A cart with items is logged first. */
export async function discardDraft(ctx: AppContext, input: { draftId: string }): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await actorTx(trx, ctx);
    const draft = await trx
      .selectFrom('sale_draft')
      .select(['id', 'cart_json', 'line_count', 'total'])
      .where('id', '=', input.draftId)
      .where('device_id', '=', ctx.session.deviceId)
      .executeTakeFirst();
    if (!draft) return;
    if (draft.line_count > 0) {
      const cart = parseCart(draft.cart_json);
      await audit(trx, ctx, {
        action: 'sale.draft_discard',
        entityType: 'sale_draft',
        entityId: draft.id,
        before: {
          lines: cart?.lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty })),
          total: draft.total,
          removed: cart?.removed ?? [],
        },
      });
    }
    await trx.deleteFrom('sale_draft').where('id', '=', draft.id).execute();
  });
}
