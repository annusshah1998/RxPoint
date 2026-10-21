import { describe, expect, it } from 'vitest';
import { createTestApp, tabletInput } from '../test-helpers';
import {
  createProduct,
  getProduct,
  listGenericNames,
  listManufacturerNames,
  setProductActive,
  toProductInput,
  updateProduct,
} from './catalog';
import { searchProducts } from './search';

describe('createProduct', () => {
  it('stores the product with units, barcodes and ingredients', async () => {
    const { app } = await createTestApp();
    const product = await createProduct(app, tabletInput());

    expect(product).toMatchObject({
      name: 'Panadol',
      strength: '500mg',
      form: 'tablet',
      manufacturer: 'GSK',
      salePrice: 73500,
      priceQty: 30,
      costPrice: 62475,
      rxRequired: false,
      isActive: true,
      ingredients: [{ generic: 'Paracetamol', strength: '500mg' }],
    });
    expect(product.units.map((u) => [u.name, u.qty, u.barcodes])).toEqual([
      ['Tablet', 1, []],
      ['Strip', 10, []],
      ['Box', 30, ['8964000000017']],
    ]);
    expect(await listManufacturerNames(app)).toEqual(['GSK']);
    expect(await listGenericNames(app)).toEqual(['Paracetamol']);
  });

  it('reuses manufacturers and generics regardless of case', async () => {
    const { app } = await createTestApp();
    await createProduct(app, tabletInput());
    await createProduct(
      app,
      tabletInput({
        name: 'Panadol Extra',
        manufacturer: 'gsk ',
        ingredients: [{ generic: 'PARACETAMOL' }, { generic: 'Caffeine', strength: '65mg' }],
        units: [{ name: 'Tablet', qty: 1, isSellable: true, barcodes: [] }],
        priceQty: 1,
      }),
    );
    expect(await listManufacturerNames(app)).toEqual(['GSK']);
    expect(await listGenericNames(app)).toEqual(['Caffeine', 'Paracetamol']);
  });

  it('marks controlled drugs as prescription-only', async () => {
    const { app } = await createTestApp();
    const product = await createProduct(
      app,
      tabletInput({ name: 'Xanax', controlledSchedule: 'b', rxRequired: false }),
    );
    expect(product.controlledSchedule).toBe('B');
    expect(product.rxRequired).toBe(true);
  });

  it.each([
    [
      'no base unit',
      { units: [{ name: 'Strip', qty: 10, isSellable: true, barcodes: [] }], priceQty: 10 },
      'units',
    ],
    ['price unit that does not exist', { priceQty: 20 }, 'priceQty'],
    ['empty name', { name: '  ' }, 'name'],
    ['negative price', { salePrice: -1 }, 'salePrice'],
    ['fractional price', { salePrice: 10.5 }, 'salePrice'],
    [
      'duplicate unit sizes',
      {
        units: [
          { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
          { name: 'Strip', qty: 10, isSellable: true, barcodes: [] },
          { name: 'Pack', qty: 10, isSellable: true, barcodes: [] },
        ],
        priceQty: 10,
      },
      'units.2.qty',
    ],
  ])('rejects %s', async (_label, overrides, field) => {
    const { app } = await createTestApp();
    await expect(createProduct(app, tabletInput(overrides))).rejects.toMatchObject({
      code: 'VALIDATION',
      fields: { [field]: expect.any(String) },
    });
  });

  it('rejects a barcode that belongs to another product', async () => {
    const { app } = await createTestApp();
    await createProduct(app, tabletInput());
    await expect(createProduct(app, tabletInput({ name: 'Calpol' }))).rejects.toMatchObject({
      code: 'BARCODE_TAKEN',
      message: 'Barcode 8964000000017 already belongs to Panadol',
      fields: { 'units.2.barcodes': expect.any(String) },
    });
  });

  it('rejects an exact duplicate', async () => {
    const { app } = await createTestApp();
    await createProduct(app, tabletInput());
    const again = tabletInput();
    again.units[2]!.barcodes = [];
    await expect(createProduct(app, again)).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('writes the audit log and sync outbox', async () => {
    const { app, db } = await createTestApp();
    const product = await createProduct(app, tabletInput());
    const audit = await db
      .selectFrom('audit_log')
      .select('action')
      .where('entity_id', '=', product.id)
      .execute();
    expect(audit.map((a) => a.action)).toEqual(['product.create']);
    const queued = await db
      .selectFrom('sync_outbox')
      .select('table_name')
      .where('table_name', 'like', 'product%')
      .execute();
    // product + 3 units + 1 barcode + 1 ingredient
    expect(queued).toHaveLength(6);
  });
});

describe('updateProduct', () => {
  it('updates fields, units, barcodes and ingredients in place', async () => {
    const { app, db } = await createTestApp();
    const created = await createProduct(app, tabletInput());
    const input = toProductInput(created);
    const [tablet, strip, box] = input.units;
    input.units = [
      { ...tablet!, isSellable: false },
      { ...strip!, name: 'Strip', qty: 14, barcodes: ['111'] }, // resized
      { ...box!, barcodes: ['8964000000017', '222'] },
    ];
    input.ingredients = [{ generic: 'Paracetamol', strength: '1g' }];
    input.rack = 'A3';

    const updated = await updateProduct(app, created.id, input);
    expect(updated.rack).toBe('A3');
    expect(updated.units.map((u) => [u.id, u.qty, u.isSellable, u.barcodes])).toEqual([
      [tablet!.id, 1, false, []],
      [strip!.id, 14, true, ['111']],
      [box!.id, 30, true, ['8964000000017', '222']],
    ]);
    expect(updated.ingredients).toMatchObject([{ generic: 'Paracetamol', strength: '1g' }]);

    const ingredientRows = await db.selectFrom('product_ingredient').selectAll().execute();
    expect(ingredientRows).toHaveLength(1); // updated, not replaced
  });

  it('deactivates removed units and their barcodes', async () => {
    const { app, db } = await createTestApp();
    const created = await createProduct(app, tabletInput());
    const input = toProductInput(created);
    input.units = input.units.filter((u) => u.name !== 'Box');
    input.priceQty = 10;
    const updated = await updateProduct(app, created.id, input);
    expect(updated.units.map((u) => u.name)).toEqual(['Tablet', 'Strip']);
    const barcode = await db.selectFrom('product_barcode').selectAll().executeTakeFirstOrThrow();
    expect(barcode.is_active).toBe(0);
  });

  it('logs price changes with before and after', async () => {
    const { app, db } = await createTestApp();
    const created = await createProduct(app, tabletInput());
    await updateProduct(
      app,
      created.id,
      { ...toProductInput(created), salePrice: 76000 },
      {
        reason: 'New DRAP price',
      },
    );
    const entry = await db
      .selectFrom('audit_log')
      .selectAll()
      .where('action', '=', 'product.price_change')
      .executeTakeFirstOrThrow();
    expect(JSON.parse(entry.before_json!)).toEqual({ sale_price: 73500 });
    expect(JSON.parse(entry.after_json!)).toEqual({ sale_price: 76000 });
    expect(entry.reason).toBe('New DRAP price');
  });

  it('writes nothing when nothing changed', async () => {
    const { app, db } = await createTestApp();
    const created = await createProduct(app, tabletInput());
    const before = await db.selectFrom('sync_outbox').select('seq').execute();
    await updateProduct(app, created.id, toProductInput(created));
    const after = await db.selectFrom('sync_outbox').select('seq').execute();
    expect(after).toHaveLength(before.length);
  });
});

describe('setProductActive', () => {
  it('hides archived products from search but keeps them', async () => {
    const { app } = await createTestApp();
    const product = await createProduct(app, tabletInput());
    await setProductActive(app, product.id, false);
    expect(await searchProducts(app, 'panadol')).toEqual([]);
    expect(await searchProducts(app, 'panadol', { includeInactive: true })).toHaveLength(1);
    expect((await getProduct(app, product.id))?.isActive).toBe(false);
  });
});
