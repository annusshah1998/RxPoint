import { describe, expect, it } from 'vitest';
import { S } from '../../strings';
import {
  changeForm,
  emptyProductForm,
  errorsByRow,
  productFormToInput,
  type ProductFormState,
} from './form-state';

function filled(): ProductFormState {
  const state = emptyProductForm();
  return {
    ...state,
    name: 'Panadol',
    salePrice: '245.67',
    units: [
      { ...state.units[0]!, barcodes: '' },
      { ...state.units[1]!, barcodes: '111, 222\n333' },
      { key: 'blank', name: '', qty: '', isSellable: true, barcodes: '' },
    ],
  };
}

describe('productFormToInput', () => {
  it('converts typed text to service input', () => {
    const { input, errors, unitKeys } = productFormToInput(filled());
    expect(errors).toEqual({});
    expect(input.salePrice).toBe(24567);
    expect(input.priceQty).toBe(10);
    expect(input.costPrice).toBeNull();
    expect(input.units).toEqual([
      { name: 'Tablet', qty: 1, isSellable: true, barcodes: [] },
      { name: 'Strip', qty: 10, isSellable: true, barcodes: ['111', '222', '333'] },
    ]);
    expect(unitKeys).toHaveLength(2); // blank row skipped
    expect(input.ingredients).toEqual([]); // blank salt row skipped
  });

  it('flags text that is not a number', () => {
    const state = { ...filled(), salePrice: 'abc', reorderLevel: '2.5' };
    state.units[1] = { ...state.units[1]!, qty: 'ten' };
    expect(productFormToInput(state).errors).toEqual({
      salePrice: S.validation.badPrice,
      reorderLevel: S.validation.wholeNumber,
      'units.1.qty': S.validation.wholeNumber,
    });
  });
});

describe('errorsByRow', () => {
  it('maps service error paths to row keys', () => {
    const conversion = { unitKeys: ['a', 'b'], saltKeys: ['s1'] };
    expect(
      errorsByRow(
        { 'units.1.barcodes': 'Taken', 'ingredients.0.generic': 'Twice', name: 'Required' },
        conversion,
      ),
    ).toEqual({ 'units.b.barcodes': 'Taken', 'salts.s1.generic': 'Twice', name: 'Required' });
  });
});

describe('changeForm', () => {
  it('renames default units but keeps custom ones', () => {
    const syrup = changeForm(emptyProductForm('tablet'), 'syrup');
    expect(syrup.units.map((u) => u.name)).toEqual(['Bottle', 'Pack']);
    const custom = emptyProductForm('tablet');
    custom.units[0]!.name = 'Tab';
    expect(changeForm(custom, 'syrup').units[0]!.name).toBe('Tab');
  });
});
