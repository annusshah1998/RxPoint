import {
  addItem,
  setBillDiscount,
  setLineDiscount,
  uuidv7,
  type Cart,
  type DiscountSpec,
  type Tender,
  type UserRole,
} from '@app/core';
import { createServiceContext, withSession, type AppContext, type ServiceContext } from './context';
import type { Db } from './executor';
import { createNodeExecutor } from './node';
import { openDatabase } from './open';
import { login } from './services/auth';
import { completeSale, getSellable, planSale } from './services/checkout';
import { saveDraft, startDraft } from './services/drafts';
import type { ProductInput } from './services/catalog';
import { setupStore } from './services/setup';
import { openShift, type OpenShift } from './services/shift';
import { createUser } from './services/users';

export interface TestApp {
  db: Db;
  /** Before login: what the login screen and setup use. */
  ctx: ServiceContext;
  /** The owner, logged in. */
  app: AppContext;
  /** The owner's PIN. */
  ownerPin: string;
  recoveryCode: string;
  /** Moves the test clock. */
  setNow(iso: string): void;
}

export const OWNER_PIN = '246810';

/** A fresh in-memory store, set up, with the owner logged in and a controllable clock. */
export async function createTestApp(options: { path?: string } = {}): Promise<TestApp> {
  const db = await openDatabase(createNodeExecutor(options.path));
  let now = new Date('2026-10-21T09:00:00Z');
  const ctx = createServiceContext(db, {
    now: () => now,
    newId: () => uuidv7(now.getTime()),
    timeZone: 'Asia/Karachi',
    // Real PINs use 120,000 iterations; tests don't need the slowness.
    pinIterations: 1_000,
    buildTime: new Date('2026-10-01T00:00:00Z'),
  });
  const { session, recoveryCode } = await setupStore(ctx, {
    pharmacyName: 'Test Pharmacy',
    tillCode: 't1',
    ownerName: 'Owner',
    ownerPin: OWNER_PIN,
    ownerPinRepeat: OWNER_PIN,
  });
  return {
    db,
    ctx,
    app: withSession(ctx, session),
    ownerPin: OWNER_PIN,
    recoveryCode,
    setNow(iso) {
      now = new Date(iso);
    },
  };
}

const ROLE_PINS: Record<UserRole, string> = {
  owner: '135791',
  pharmacist: '2580',
  cashier: '1470',
  inventory: '3690',
};

export interface TestUser {
  id: string;
  name: string;
  pin: string;
  app: AppContext;
}

/** Adds a user with `role` (created by the owner) and logs them in. */
export async function asRole(t: TestApp, role: UserRole, name?: string): Promise<TestUser> {
  const pin = ROLE_PINS[role];
  const user = await createUser(t.app, {
    name: name ?? `${role[0]!.toUpperCase()}${role.slice(1)}`,
    role,
    pin,
    pinRepeat: pin,
  });
  const session = await login(t.ctx, { userId: user.id, pin });
  return { id: user.id, name: user.name, pin, app: withSession(t.ctx, session) };
}

/** Opens a shift for `app` with a Rs 5,000 float (or `float`). */
export function openTestShift(app: AppContext, float = 500_000): Promise<OpenShift> {
  return openShift(app, { openingFloat: float });
}

/** A tablet product: Box of 3 strips of 10, priced per box. */
export function tabletInput(overrides: Partial<ProductInput> = {}): ProductInput {
  return {
    name: 'Panadol',
    strength: '500mg',
    form: 'tablet',
    manufacturer: 'GSK',
    ingredients: [{ generic: 'Paracetamol', strength: '500mg' }],
    units: [
      { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
      { name: 'Strip', qty: 10, isSellable: true, barcodes: [] },
      { name: 'Box', qty: 30, isSellable: true, barcodes: ['8964000000017'] },
    ],
    salePrice: 73500,
    priceQty: 30,
    costPrice: 62475,
    rxRequired: false,
    ...overrides,
  };
}

export interface CartItem {
  productId: string;
  /** Unit name the quantity is in, e.g. 'Strip'; the base unit when left out. */
  unit?: string;
  qty: number;
  discount?: DiscountSpec;
  key?: string;
}

/** Rings up items on this till's draft (as the sale screen would) and saves it. */
export async function ringUp(
  app: AppContext,
  items: CartItem[],
  bill: DiscountSpec | null = null,
): Promise<Cart> {
  let cart = (await startDraft(app)).cart;
  for (const [i, item] of items.entries()) {
    const sellable = await getSellable(app, item.productId);
    if (!sellable) throw new Error(`no product ${item.productId}`);
    const unit = item.unit
      ? sellable.product.units.find((u) => u.name === item.unit)!
      : sellable.product.units.find((u) => u.qty === 1)!;
    const key = item.key ?? `k${i + 1}`;
    cart = addItem(cart, sellable.product, unit.id, item.qty * unit.qty, key);
    if (item.discount) cart = setLineDiscount(cart, key, item.discount);
  }
  if (bill) cart = setBillDiscount(cart, bill);
  await saveDraft(app, cart);
  return cart;
}

/** Saves `cart` and completes it at the total planSale shows (cash exact if no tenders given). */
export async function checkout(app: AppContext, cart: Cart, tenders?: Tender[]) {
  await saveDraft(app, cart);
  const plan = await planSale(app, cart);
  if (!plan.totals) throw new Error(`cart has problems: ${JSON.stringify(plan.fields)}`);
  const total = plan.totals.total;
  return completeSale(app, {
    draftId: cart.id,
    tenders: tenders ?? (total > 0 ? [{ method: 'cash', tendered: total }] : []),
    expectedTotal: total,
  });
}
