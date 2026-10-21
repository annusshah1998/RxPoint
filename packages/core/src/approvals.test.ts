import { describe, expect, it } from 'vitest';
import { canonicalJson, grantCovers, grantScope, type Grant } from './approvals';
import {
  addItem,
  newCart,
  setBillDiscount,
  setLineDiscount,
  setPrescription,
  setQty,
  type CartProduct,
} from './cart';

const units = [
  { id: 'tab', name: 'Tablet', qty: 1, isSellable: true },
  { id: 'strip', name: 'Strip', qty: 6, isSellable: true },
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
const panadol: CartProduct = { ...augmentin, productId: 'pan', name: 'Panadol', rx: 'none' };
const diazepam: CartProduct = { ...augmentin, productId: 'dia', rx: 'controlled', schedule: 'B' };

function cart() {
  let c = newCart('d1', 'cashier', '2026-10-21T09:00:00Z');
  c = addItem(c, augmentin, 'tab', 8, 'k1');
  c = setLineDiscount(c, 'k1', { kind: 'percent', bp: 1000 });
  c = addItem(c, panadol, 'strip', 6, 'k2');
  return c;
}

function grant(c: ReturnType<typeof cart>, over: Partial<Grant> = {}): Grant {
  const kind = over.kind ?? 'sale.discount';
  const lineKey = over.lineKey ?? 'k1';
  return {
    kind,
    lineKey,
    scopeJson: grantScope(c, kind, lineKey),
    approvedBp: 1180,
    requestedBy: 'cashier',
    approverId: 'pharm',
    ...over,
  };
}

describe('approval scopes', () => {
  it('writes the same JSON whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}',
    );
  });

  it('covers the approved line until it changes', () => {
    const c = cart();
    const g = grant(c);
    // Augmentin: 10% off + a 2% bill share = 11.8%.
    expect(grantCovers(g, c, 'cashier', { discount: 6863, gross: 58160 })).toBe(true);
    // More than was approved.
    expect(grantCovers(g, c, 'cashier', { discount: 7000, gross: 58160 })).toBe(false);
    // Another line can change without affecting this line's approval.
    expect(grantCovers(g, setQty(c, 'k2', 12), 'cashier', { discount: 6863, gross: 58160 })).toBe(
      true,
    );
    // Changing the line, or the bill discount, needs a new approval.
    expect(grantCovers(g, setQty(c, 'k1', 9), 'cashier', { discount: 6863, gross: 58160 })).toBe(
      false,
    );
    const withBill = setBillDiscount(c, { kind: 'percent', bp: 200 });
    expect(grantCovers(g, withBill, 'cashier', { discount: 6863, gross: 58160 })).toBe(false);
  });

  it('belongs to the person who was selling', () => {
    const c = cart();
    expect(grantCovers(grant(c), c, 'someone-else', { discount: 6863, gross: 58160 })).toBe(false);
  });

  it('allows one paisa of drift from the bill share', () => {
    const c = cart();
    const g = grant(c, { approvedBp: 1180 });
    // 11.80% of 58160 = 6862.88; a share moving by a paisa gives 6864.
    expect(grantCovers(g, c, 'cashier', { discount: 6864, gross: 58160 })).toBe(true);
    expect(grantCovers(g, c, 'cashier', { discount: 6866, gross: 58160 })).toBe(false);
  });

  it('ties a bill approval to every line', () => {
    const c = setBillDiscount(cart(), { kind: 'percent', bp: 1500 });
    const g = grant(c, { lineKey: '', approvedBp: 2400 });
    expect(grantCovers(g, c, 'cashier', { discount: 1000, gross: 10000 })).toBe(true);
    expect(grantCovers(g, setQty(c, 'k2', 12), 'cashier', { discount: 1000, gross: 10000 })).toBe(
      false,
    );
  });

  it('ties a controlled-drug approval to the lines and the prescription', () => {
    let c = addItem(cart(), diazepam, 'tab', 10, 'k3');
    c = setPrescription(c, { patientName: 'Ali', prescriberName: 'Dr Khan' });
    const g = grant(c, { kind: 'sale.controlled', lineKey: '', approvedBp: null });
    expect(grantCovers(g, c, 'cashier')).toBe(true);
    // Other lines don't matter.
    expect(grantCovers(g, setQty(c, 'k2', 12), 'cashier')).toBe(true);
    expect(grantCovers(g, setQty(c, 'k3', 20), 'cashier')).toBe(false);
    expect(
      grantCovers(
        g,
        setPrescription(c, { patientName: 'Bilal', prescriberName: 'Dr Khan' }),
        'cashier',
      ),
    ).toBe(false);
  });
});
