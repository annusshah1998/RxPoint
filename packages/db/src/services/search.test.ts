import { beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, tabletInput, type TestApp } from '../test-helpers';
import { createProduct } from './catalog';
import { findProductByBarcode, rebuildSearchIndex, searchProducts } from './search';
import { addOpeningStock } from './stock';

let t: TestApp;

const one = (name: string) => [{ name, qty: 1, isSellable: true, barcodes: [] as string[] }];

beforeAll(async () => {
  t = await createTestApp();
  const panadol = await createProduct(t.app, tabletInput());
  await addOpeningStock(t.app, {
    productId: panadol.id,
    batchNo: 'P1',
    expiryDate: '2027-06-30',
    qty: 45,
  });
  await createProduct(t.app, {
    ...tabletInput(),
    name: 'Augmentin',
    strength: '625mg',
    manufacturer: 'GSK',
    ingredients: [
      { generic: 'Amoxicillin', strength: '500mg' },
      { generic: 'Clavulanic Acid', strength: '125mg' },
    ],
    units: [
      { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
      { name: 'Strip', qty: 6, isSellable: true, barcodes: ['5000000000001'] },
    ],
    priceQty: 6,
  });
  await createProduct(t.app, {
    ...tabletInput(),
    name: 'Calpol',
    strength: '120mg/5ml',
    form: 'syrup',
    manufacturer: 'GSK',
    ingredients: [{ generic: 'Paracetamol', strength: '120mg/5ml' }],
    units: one('Bottle'),
    priceQty: 1,
  });
  await createProduct(t.app, {
    ...tabletInput(),
    name: 'Pan',
    strength: '40mg',
    manufacturer: 'Getz Pharma',
    ingredients: [{ generic: 'Pantoprazole', strength: '40mg' }],
    units: one('Tablet'),
    priceQty: 1,
  });
});

const names = async (query: string) => (await searchProducts(t.app, query)).map((h) => h.name);

describe('searchProducts', () => {
  it('finds by any part of the brand name', async () => {
    expect(await names('augm')).toEqual(['Augmentin']);
    expect(await names('GMENT')).toEqual(['Augmentin']);
  });

  it('finds by generic / salt', async () => {
    expect(await names('amoxi')).toEqual(['Augmentin']);
    expect(await names('clav')).toEqual(['Augmentin']);
    expect((await names('paracetamol')).sort()).toEqual(['Calpol', 'Panadol']);
  });

  it('finds by manufacturer and strength', async () => {
    expect(await names('getz')).toEqual(['Pan']);
    expect(await names('625')).toEqual(['Augmentin']);
  });

  it('requires every word to match', async () => {
    expect(await names('paracetamol syrup 120')).toEqual(['Calpol']);
    expect(await names('paracetamol 120')).toEqual(['Calpol']);
    expect(await names('amoxi 40mg')).toEqual([]);
  });

  it('handles words shorter than three letters', async () => {
    expect(await names('pa')).toEqual(['Pan', 'Panadol', 'Calpol']);
    expect(await names('pan 40')).toEqual(['Pan']);
  });

  it('ranks exact and starts-with brand matches first', async () => {
    expect((await names('pan'))[0]).toBe('Pan');
    expect((await names('pan')).slice(0, 2)).toEqual(['Pan', 'Panadol']);
  });

  it('lists everything for an empty query', async () => {
    expect(await names('')).toEqual(['Augmentin', 'Calpol', 'Pan', 'Panadol']);
  });

  it('treats quotes and symbols as plain text', async () => {
    expect(await names('"pan')).toEqual([]);
    expect(await names('50%')).toEqual([]);
  });

  it('returns stock, units and price for display', async () => {
    const [hit] = await searchProducts(t.app, 'panadol');
    expect(hit).toMatchObject({
      name: 'Panadol',
      generics: 'Paracetamol',
      manufacturer: 'GSK',
      salePrice: 73500,
      priceQty: 30,
      stockQty: 45,
    });
    expect(hit!.units.map((u) => u.name)).toEqual(['Tablet', 'Strip', 'Box']);
  });

  it('finds a scanned barcode and remembers which pack it was', async () => {
    const hits = await searchProducts(t.app, '5000000000001');
    expect(hits.map((h) => h.name)).toEqual(['Augmentin']);
    const strip = hits[0]!.units.find((u) => u.name === 'Strip');
    expect(hits[0]!.scannedUnitId).toBe(strip!.id);
    expect(await findProductByBarcode(t.app, 'nope')).toBeNull();
  });

  it('gives the same results after a full rebuild', async () => {
    const before = await names('para');
    await rebuildSearchIndex(t.db);
    expect(await names('para')).toEqual(before);
  });
});
