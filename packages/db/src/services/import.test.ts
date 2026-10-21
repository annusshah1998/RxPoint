import { describe, expect, it } from 'vitest';
import { createTestApp, tabletInput } from '../test-helpers';
import { createProduct, getProduct } from './catalog';
import {
  IMPORT_TEMPLATE_CSV,
  guessMapping,
  parseCsv,
  parsePackSize,
  planImport,
  runImport,
} from './import';
import { searchProducts } from './search';
import { getProductStock } from './stock';

describe('parsePackSize', () => {
  it.each([
    ['', { inner: null, outer: null }],
    ['10', { inner: 10, outer: null }],
    ["10's", { inner: 10, outer: null }],
    ['14 tabs', { inner: 14, outer: null }],
    ['20x10', { inner: 10, outer: 20 }],
    ['20 X 10', { inner: 10, outer: 20 }],
    ['1x10', { inner: 10, outer: 1 }],
    ['120ml', 'ignored'],
    ['1x120ml', 'ignored'],
    ['ten', null],
  ])('reads %j', (text, expected) => {
    expect(parsePackSize(text)).toEqual(expected);
  });
});

describe('guessMapping', () => {
  it('matches common spreadsheet headers', () => {
    const mapping = guessMapping([
      'Item Name',
      'Salt',
      'Company',
      'Packing',
      'Retail Price',
      'TP',
      'Batch No.',
      'Exp Date',
      'Qty',
      'Unknown',
    ]);
    expect(mapping).toEqual({
      name: 0,
      generic: 1,
      manufacturer: 2,
      packSize: 3,
      salePrice: 4,
      costPrice: 5,
      batchNo: 6,
      expiry: 7,
      stockQty: 8,
    });
  });

  it('matches the template headers exactly', () => {
    const { headers } = parseCsv(IMPORT_TEMPLATE_CSV);
    const mapping = guessMapping(headers);
    expect(Object.keys(mapping)).toHaveLength(headers.length);
  });
});

async function plan(csv: string) {
  const t = await createTestApp();
  const parsed = parseCsv(csv);
  return { ...t, parsed, plan: await planImport(t.app, parsed, guessMapping(parsed.headers)) };
}

describe('planImport', () => {
  it('builds products, pack sizes and stock from the template', async () => {
    const { plan: result } = await plan(IMPORT_TEMPLATE_CSV);
    expect(result.counts).toEqual({
      newProducts: 3,
      existingProducts: 0,
      stockLines: 3,
      errors: 0,
    });
    const [paracetamol, coAmoxiclav, ibuprofen] = result.rows;
    expect(paracetamol!.product).toMatchObject({
      name: 'Sample Paracetamol',
      form: 'tablet',
      salePrice: 52000,
      priceQty: 200,
      units: [
        { name: 'Tablet', qty: 1 },
        { name: 'Strip', qty: 10 },
        { name: 'Box', qty: 200 },
      ],
    });
    expect(paracetamol!.stock).toEqual({
      batchNo: 'PC2401',
      expiryDate: '2027-06-30',
      qty: 180,
      packQty: 200,
      costPrice: 44200,
      mrp: 52000,
    });
    expect(coAmoxiclav!.product).toMatchObject({
      rxRequired: true,
      priceQty: 6,
      ingredients: [{ generic: 'Amoxicillin' }, { generic: 'Clavulanic Acid' }],
    });
    expect(coAmoxiclav!.stock?.qty).toBe(24); // 4 strips of 6
    expect(ibuprofen!.product?.units).toMatchObject([{ name: 'Bottle', qty: 1 }]);
  });

  it('reports row problems without stopping', async () => {
    const csv = [
      'name,form,pack_size,sale_price,expiry,stock_qty,controlled',
      ',tablet,10,100,,,',
      'Good,tablet,10,100,03/2027,5,',
      'Bad expiry,tablet,10,100,soon,5,',
      'Bad price,tablet,10,abc,,,',
      'Bad pack,tablet,ten,100,,,',
      'Controlled yes,tablet,10,100,,,yes',
      'Guess Tab 500mg,,10,100,,,',
    ].join('\n');
    const { plan: result } = await plan(csv);
    expect(result.rows.map((r) => [r.rowNumber, r.status, r.errors])).toEqual([
      [2, 'error', ['Missing product name']],
      [3, 'new', []],
      [4, 'error', [`Can't read expiry "soon" (try 03/2027)`]],
      [5, 'error', [`Can't read sale price "abc"`]],
      [6, 'error', [`Can't read pack size "ten" (try 10 or 20x10)`]],
      [7, 'error', ['Controlled: give the schedule (e.g. B or D) instead of "yes"']],
      [8, 'new', []],
    ]);
    expect(result.rows[1]!.warnings).toEqual(['Stock has no batch number']);
    expect(result.rows[6]!.product?.form).toBe('tablet'); // guessed from "Tab"
  });

  it('recognises products already in the catalog, by name or barcode', async () => {
    const t = await createTestApp();
    await createProduct(t.app, tabletInput());
    const csv = [
      'name,strength,form,manufacturer,barcode,pack_size,sale_price',
      'Panadol,500mg,Tablet,GSK,,3x10,735',
      'Something Else,,Tablet,,8964000000017,10,1',
    ].join('\n');
    const parsed = parseCsv(csv);
    const result = await planImport(t.app, parsed, guessMapping(parsed.headers));
    expect(result.rows.map((r) => r.status)).toEqual(['existing', 'existing']);
    expect(result.rows[1]!.warnings).toContain('Matched to existing product Panadol by barcode');
    expect(result.counts.existingProducts).toBe(1);
  });
});

describe('runImport', () => {
  it('imports products and stock, and makes them searchable', async () => {
    const { app, plan: result } = await plan(IMPORT_TEMPLATE_CSV);
    const progress: number[] = [];
    const outcome = await runImport(app, result, (done) => progress.push(done));
    expect(outcome).toEqual({ productsCreated: 3, stockLinesAdded: 3, failed: [] });
    expect(progress).toEqual([3]);

    const [hit] = await searchProducts(app, 'clavulanic');
    expect(hit?.name).toBe('Sample Co-Amoxiclav');
    expect(hit?.stockQty).toBe(24);
  });

  it('adds several batches of the same product from repeated rows', async () => {
    const csv = [
      'name,form,pack_size,sale_price,batch_no,expiry,stock_qty',
      'Panadol,tablet,10,100,A,03/2027,10',
      'Panadol,tablet,10,100,B,06/2027,20',
    ].join('\n');
    const { app, plan: result } = await plan(csv);
    expect(result.rows[1]!.repeatOf).toBe(2);
    expect(result.counts).toMatchObject({ newProducts: 1, stockLines: 2 });

    const outcome = await runImport(app, result);
    expect(outcome.productsCreated).toBe(1);
    const [hit] = await searchProducts(app, 'panadol');
    const stock = await getProductStock(app, hit!.id);
    expect(stock.batches.map((b) => [b.batchNo, b.qty])).toEqual([
      ['A', 10],
      ['B', 20],
    ]);
  });

  it('isolates a failing row and imports the rest', async () => {
    const t = await createTestApp();
    const csv = [
      'name,form,pack_size,sale_price,barcode',
      'One,tablet,10,100,111',
      'Two,tablet,10,100,222',
    ].join('\n');
    const parsed = parseCsv(csv);
    const result = await planImport(t.app, parsed, guessMapping(parsed.headers));
    // Someone adds barcode 222 between planning and running.
    await createProduct(
      t.app,
      tabletInput({
        name: 'Sneaky',
        units: [{ name: 'Tablet', qty: 1, isSellable: true, barcodes: ['222'] }],
        priceQty: 1,
      }),
    );
    const outcome = await runImport(t.app, result);
    expect(outcome.productsCreated).toBe(1);
    expect(outcome.failed).toEqual([
      { rowNumber: 3, error: 'Barcode 222 already belongs to Sneaky' },
    ]);
    const [one] = await searchProducts(t.app, 'one');
    expect(await getProduct(t.app, one!.id)).not.toBeNull();
  });
});
