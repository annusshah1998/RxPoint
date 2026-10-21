import { describe, expect, it } from 'vitest';
import {
  addItem,
  bumpQty,
  cycleUnit,
  defaultSaleUnit,
  displayQty,
  newCart,
  pickBatches,
  removeLine,
  setLineDiscount,
  setPrice,
  setQty,
  toPricingLines,
  undoRemove,
  type CartProduct,
} from './cart';

const units = [
  { id: 'tab', name: 'Tablet', qty: 1, isSellable: true },
  { id: 'strip', name: 'Strip', qty: 6, isSellable: true },
  { id: 'box', name: 'Box', qty: 18, isSellable: true },
];
const augmentin: CartProduct = {
  productId: 'aug',
  name: 'Augmentin 625mg',
  units,
  price: { amount: 43620, perQty: 6 },
  allowDiscount: true,
  taxRateBp: 0,
  rx: 'required',
  schedule: null,
};
const start = () => newCart('cart-1', 'user-1', '2026-10-21T09:00:00Z');

describe('cart', () => {
  it('adds items and merges repeat scans of a plain line', () => {
    let cart = addItem(start(), augmentin, 'strip', 6, 'k1');
    cart = addItem(cart, augmentin, 'strip', 6, 'k2');
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({
      key: 'k1',
      qty: 12,
      unitId: 'strip',
      priceSource: 'catalog',
    });
    expect(cart.selectedKey).toBe('k1');
    expect(displayQty(cart.lines[0]!)).toBe('2 Strips');
  });

  it('keeps a discounted or batch-picked line separate', () => {
    let cart = addItem(start(), augmentin, 'strip', 6, 'k1');
    cart = setLineDiscount(cart, 'k1', { kind: 'percent', bp: 1000 });
    cart = addItem(cart, augmentin, 'strip', 6, 'k2');
    expect(cart.lines.map((l) => l.key)).toEqual(['k1', 'k2']);
  });

  it('bumps by the line unit and cycles units', () => {
    let cart = addItem(start(), augmentin, 'strip', 6, 'k1');
    cart = bumpQty(cart, 'k1', 1);
    expect(cart.lines[0]!.qty).toBe(12);
    cart = bumpQty(cart, 'k1', -1);
    cart = bumpQty(cart, 'k1', -1); // never below one strip
    expect(cart.lines[0]!.qty).toBe(6);
    cart = setQty(cart, 'k1', 12);
    cart = cycleUnit(cart, 'k1', 1); // 2 strips → 2 boxes
    expect(cart.lines[0]).toMatchObject({ qty: 36, unitId: 'box' });
    cart = cycleUnit(cart, 'k1', 1); // → 2 tablets
    expect(cart.lines[0]).toMatchObject({ qty: 2, unitId: 'tab' });
  });

  it('shows mixed quantities', () => {
    const cart = addItem(start(), augmentin, 'strip', 8, 'k1');
    expect(displayQty(cart.lines[0]!)).toBe('1 Strip, 2 Tablets');
  });

  it('removes with undo and keeps a removal log', () => {
    let cart = addItem(start(), augmentin, 'strip', 6, 'k1');
    cart = removeLine(cart, 'k1', 'user-1', '2026-10-21T09:01:00Z', 43620);
    expect(cart.lines).toHaveLength(0);
    expect(cart.removed).toEqual([
      {
        productId: 'aug',
        name: 'Augmentin 625mg',
        qty: 6,
        gross: 43620,
        at: '2026-10-21T09:01:00Z',
        by: 'user-1',
      },
    ]);
    cart = undoRemove(cart);
    expect(cart.lines.map((l) => l.key)).toEqual(['k1']);
    expect(cart.removed).toEqual([]);
  });

  it('checks batch picks add up and clears them when the quantity changes', () => {
    let cart = addItem(start(), augmentin, 'strip', 6, 'k1');
    expect(() => pickBatches(cart, 'k1', [{ batchId: 'b', qty: 5 }])).toThrow();
    cart = pickBatches(cart, 'k1', [{ batchId: 'b', qty: 6 }]);
    expect(cart.lines[0]!.batches).toEqual([{ batchId: 'b', qty: 6 }]);
    cart = setQty(cart, 'k1', 12);
    expect(cart.lines[0]!.batches).toBeNull();
  });

  it('sets and resets prices', () => {
    let cart = addItem(start(), augmentin, 'strip', 6, 'k1');
    cart = setPrice(cart, 'k1', { amount: 41500, perQty: 6 }, 'mrp');
    expect(cart.lines[0]).toMatchObject({
      price: { amount: 41500, perQty: 6 },
      priceSource: 'mrp',
    });
    cart = setPrice(cart, 'k1', { amount: 0, perQty: 1 }, 'catalog');
    expect(cart.lines[0]).toMatchObject({ price: augmentin.price, priceSource: 'catalog' });
    expect(toPricingLines(cart)[0]).toEqual({
      key: 'k1',
      price: augmentin.price,
      qty: 6,
      taxRateBp: 0,
      allowDiscount: true,
      discount: 'default',
    });
  });

  it('picks the default sale unit', () => {
    expect(defaultSaleUnit(units, 'strip').id).toBe('strip');
    expect(defaultSaleUnit(units, 'base').id).toBe('tab');
    const noLoose = units.map((u) => (u.id === 'tab' ? { ...u, isSellable: false } : u));
    expect(defaultSaleUnit(noLoose, 'base').id).toBe('strip');
    expect(
      defaultSaleUnit([{ id: 'b', name: 'Bottle', qty: 1, isSellable: true }], 'strip').id,
    ).toBe('b');
  });
});
