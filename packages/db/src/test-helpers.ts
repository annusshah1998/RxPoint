import { uuidv7 } from '@app/core';
import { createServiceContext, withSession, type AppContext } from './context';
import type { Db } from './executor';
import { createNodeExecutor } from './node';
import { openDatabase } from './open';
import type { ProductInput } from './services/catalog';
import { setupStore } from './services/setup';

export interface TestApp {
  db: Db;
  app: AppContext;
  /** Moves the test clock. */
  setNow(iso: string): void;
}

/** A fresh in-memory store, set up and ready, with a controllable clock. */
export async function createTestApp(): Promise<TestApp> {
  const db = await openDatabase(createNodeExecutor());
  let now = new Date('2026-10-21T09:00:00Z');
  const ctx = createServiceContext(db, {
    now: () => now,
    newId: () => uuidv7(now.getTime()),
    timeZone: 'Asia/Karachi',
  });
  const session = await setupStore(ctx, {
    pharmacyName: 'Test Pharmacy',
    tillCode: 't1',
    ownerName: 'Owner',
  });
  return {
    db,
    app: withSession(ctx, session),
    setNow(iso) {
      now = new Date(iso);
    },
  };
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
