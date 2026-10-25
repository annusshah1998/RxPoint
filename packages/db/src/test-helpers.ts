import {
  addItem,
  setBillDiscount,
  setLineDiscount,
  setRxCheck,
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
import { createProduct, type ProductInput } from './services/catalog';
import { setupStore } from './services/setup';
import { openShift, type OpenShift } from './services/shift';
import { addOpeningStock } from './services/stock';
import { createUser } from './services/users';
import { insertRow } from './writes';

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

/**
 * The worked sale from docs/m2-design.md §3.1:
 *   Panadol 500mg 2 strips, Brufen 400mg 3 tablets (no stock on record),
 *   Augmentin 625mg 8 tablets at 10% off, a thermometer (18% tax, never discounted),
 *   and 2% off the bill. Total Rs 1,965.00 (rounding −0.39).
 */
export async function workedStore(t?: TestApp) {
  t ??= await createTestApp();
  const now = '2026-10-21T09:00:00.000Z';
  const vat = 'tax-18';
  await t.db.transaction().execute((trx) =>
    insertRow(trx, now, 'tax_class', {
      id: vat,
      name: 'GST 18%',
      rate_bp: 1800,
      is_active: 1,
      created_at: now,
      updated_at: now,
    }),
  );
  const panadol = await createProduct(t.app, tabletInput());
  const brufen = await createProduct(
    t.app,
    tabletInput({
      name: 'Brufen',
      strength: '400mg',
      manufacturer: 'Abbott',
      ingredients: [{ generic: 'Ibuprofen', strength: '400mg' }],
      units: [
        { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
        { name: 'Strip', qty: 10, isSellable: true, barcodes: [] },
      ],
      salePrice: 24567,
      priceQty: 10,
      costPrice: null,
    }),
  );
  const augmentin = await createProduct(
    t.app,
    tabletInput({
      name: 'Augmentin',
      strength: '625mg',
      ingredients: [{ generic: 'Amoxicillin', strength: '500mg' }],
      units: [
        { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
        { name: 'Strip', qty: 6, isSellable: true, barcodes: [] },
        { name: 'Box', qty: 18, isSellable: true, barcodes: ['8961234567890'] },
      ],
      salePrice: 43620,
      priceQty: 6,
      costPrice: 37077,
      rxRequired: true,
    }),
  );
  const thermometer = await createProduct(t.app, {
    name: 'Thermometer',
    form: 'device',
    units: [{ name: 'Piece', qty: 1, isSellable: true, barcodes: [] }],
    salePrice: 89999,
    priceQty: 1,
    costPrice: 60000,
    taxClassId: vat,
    allowDiscount: false,
  });
  const pn01 = await addOpeningStock(t.app, {
    productId: panadol.id,
    batchNo: 'PN-01',
    expiryDate: '2027-01-31',
    qty: 15,
    costPrice: 62475,
    mrp: 73500,
  });
  const pn02 = await addOpeningStock(t.app, {
    productId: panadol.id,
    batchNo: 'PN-02',
    expiryDate: '2027-06-30',
    qty: 30,
    costPrice: 62475,
    mrp: 73500,
  });
  const au = await addOpeningStock(t.app, {
    productId: augmentin.id,
    batchNo: 'AU1123',
    expiryDate: '2027-03-31',
    qty: 18,
    costPrice: 37077,
    mrp: 41500,
  });
  await addOpeningStock(t.app, {
    productId: thermometer.id,
    batchNo: 'TH-1',
    expiryDate: null,
    qty: 5,
    costPrice: 60000,
  });
  return {
    ...t,
    panadol,
    brufen,
    augmentin,
    thermometer,
    batches: { pn01: pn01.batchId, pn02: pn02.batchId, au: au.batchId },
  };
}

export type WorkedStore = Awaited<ReturnType<typeof workedStore>>;

export async function workedCart(s: WorkedStore, app = s.app): Promise<Cart> {
  const cart = await ringUp(
    app,
    [
      { productId: s.panadol.id, unit: 'Strip', qty: 2 },
      { productId: s.brufen.id, unit: 'Tablet', qty: 3 },
      {
        productId: s.augmentin.id,
        unit: 'Tablet',
        qty: 8,
        discount: { kind: 'percent', bp: 1000 },
      },
      { productId: s.thermometer.id, qty: 1 },
    ],
    { kind: 'percent', bp: 200 },
  );
  return setRxCheck(cart, 'seen');
}

/** Card Rs 1,000 (slip 4417) plus Rs 1,000 cash for the worked sale. */
export const WORKED_SPLIT = [
  { method: 'card' as const, amount: 100000, reference: '4417' },
  { method: 'cash' as const, tendered: 100000 },
];
