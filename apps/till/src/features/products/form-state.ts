import {
  DEFAULT_BASE_UNIT,
  defaultPackUnit,
  parseMoney,
  toMajorString,
  type ProductForm,
} from '@app/core';
import type { ProductDetail, ProductInput } from '@app/db';
import { S } from '../../strings';

/**
 * What the product form edits: text as typed, converted to a ProductInput on save.
 * Rows carry a stable `key` for React and for mapping errors back to rows.
 */
export interface UnitRow {
  key: string;
  id?: string;
  name: string;
  qty: string;
  isSellable: boolean;
  barcodes: string;
}

export interface SaltRow {
  key: string;
  generic: string;
  strength: string;
}

export interface ProductFormState {
  name: string;
  strength: string;
  form: ProductForm;
  manufacturer: string;
  salts: SaltRow[];
  /** The first row is the base unit (holds 1). */
  units: UnitRow[];
  salePrice: string;
  /** Base units the price is for, as text (matches a unit's qty). */
  priceQty: string;
  costPrice: string;
  taxClassId: string;
  rxRequired: boolean;
  controlledSchedule: string;
  rack: string;
  reorderLevel: string;
  notes: string;
}

let nextKey = 0;
export const rowKey = () => `row-${++nextKey}`;

export function emptyProductForm(form: ProductForm = 'tablet'): ProductFormState {
  return {
    name: '',
    strength: '',
    form,
    manufacturer: '',
    salts: [{ key: rowKey(), generic: '', strength: '' }],
    units: [
      { key: rowKey(), name: DEFAULT_BASE_UNIT[form], qty: '1', isSellable: true, barcodes: '' },
      { key: rowKey(), name: defaultPackUnit(form), qty: '10', isSellable: true, barcodes: '' },
    ],
    salePrice: '',
    priceQty: '10',
    costPrice: '',
    taxClassId: '',
    rxRequired: false,
    controlledSchedule: '',
    rack: '',
    reorderLevel: '',
    notes: '',
  };
}

export function productFormFromDetail(p: ProductDetail): ProductFormState {
  return {
    name: p.name,
    strength: p.strength ?? '',
    form: p.form,
    manufacturer: p.manufacturer ?? '',
    salts: p.ingredients.map((i) => ({
      key: rowKey(),
      generic: i.generic,
      strength: i.strength ?? '',
    })),
    units: p.units.map((u) => ({
      key: rowKey(),
      id: u.id,
      name: u.name,
      qty: String(u.qty),
      isSellable: u.isSellable,
      barcodes: u.barcodes.join(', '),
    })),
    salePrice: toMajorString(p.salePrice),
    priceQty: String(p.priceQty),
    costPrice: p.costPrice === null ? '' : toMajorString(p.costPrice),
    taxClassId: p.taxClassId ?? '',
    rxRequired: p.rxRequired,
    controlledSchedule: p.controlledSchedule ?? '',
    rack: p.rack ?? '',
    reorderLevel: p.reorderLevel === null ? '' : String(p.reorderLevel),
    notes: p.notes ?? '',
  };
}

/** Changing the form updates unit names that were still the defaults. */
export function changeForm(state: ProductFormState, form: ProductForm): ProductFormState {
  const units = state.units.map((unit, i) => {
    if (i === 0 && unit.name === DEFAULT_BASE_UNIT[state.form]) {
      return { ...unit, name: DEFAULT_BASE_UNIT[form] };
    }
    if (i === 1 && unit.name === defaultPackUnit(state.form)) {
      return { ...unit, name: defaultPackUnit(form) };
    }
    return unit;
  });
  return { ...state, form, units };
}

const WHOLE = /^\d+$/;

function parseWhole(text: string): number | null {
  const t = text.trim().replace(/,/g, '');
  return WHOLE.test(t) ? Number(t) : null;
}

export interface FormConversion {
  input: ProductInput;
  /** Problems found before the service sees the input, keyed like service errors. */
  errors: Record<string, string>;
  /** Row key for each unit index in `input.units`, to show service errors on the right row. */
  unitKeys: string[];
  saltKeys: string[];
}

export function productFormToInput(state: ProductFormState): FormConversion {
  const errors: Record<string, string> = {};

  const salePrice = parseMoney(state.salePrice);
  if (salePrice === null) errors.salePrice = S.validation.badPrice;
  let costPrice: number | null = null;
  if (state.costPrice.trim()) {
    costPrice = parseMoney(state.costPrice);
    if (costPrice === null) errors.costPrice = S.validation.badPrice;
  }

  // Ignore completely empty pack and salt rows.
  const unitRows = state.units.filter(
    (row, i) => i === 0 || row.name.trim() || row.qty.trim() || row.barcodes.trim(),
  );
  const units = unitRows.map((row, i) => {
    const qty = parseWhole(row.qty);
    if (qty === null || qty < 1) errors[`units.${i}.qty`] = S.validation.wholeNumber;
    return {
      ...(row.id ? { id: row.id } : {}),
      name: row.name,
      qty: qty ?? 0,
      isSellable: row.isSellable,
      barcodes: row.barcodes.split(/[\s,;]+/).filter(Boolean),
    };
  });

  const saltRows = state.salts.filter((row) => row.generic.trim() || row.strength.trim());

  let reorderLevel: number | null = null;
  if (state.reorderLevel.trim()) {
    reorderLevel = parseWhole(state.reorderLevel);
    if (reorderLevel === null) errors.reorderLevel = S.validation.wholeNumber;
  }

  return {
    input: {
      name: state.name,
      strength: state.strength,
      form: state.form,
      manufacturer: state.manufacturer,
      ingredients: saltRows.map((row) => ({ generic: row.generic, strength: row.strength })),
      units,
      salePrice: salePrice ?? 0,
      priceQty: parseWhole(state.priceQty) ?? 0,
      costPrice,
      taxClassId: state.taxClassId || null,
      rxRequired: state.rxRequired,
      controlledSchedule: state.controlledSchedule || null,
      rack: state.rack,
      reorderLevel,
      notes: state.notes,
    },
    errors,
    unitKeys: unitRows.map((row) => row.key),
    saltKeys: saltRows.map((row) => row.key),
  };
}

/**
 * Re-keys errors from input indexes ("units.2.qty") to row keys ("units.row-7.qty")
 * so they land on the right row even when blank rows were skipped.
 */
export function errorsByRow(
  errors: Record<string, string>,
  conversion: Pick<FormConversion, 'unitKeys' | 'saltKeys'>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(errors)) {
    const match = /^(units|ingredients)\.(\d+)(\..+)?$/.exec(path);
    if (!match) {
      out[path] = message;
      continue;
    }
    const keys = match[1] === 'units' ? conversion.unitKeys : conversion.saltKeys;
    const key = keys[Number(match[2])];
    const list = match[1] === 'units' ? 'units' : 'salts';
    out[key ? `${list}.${key}${match[3] ?? ''}` : list] = message;
  }
  return out;
}
