import { nameKey } from './text';

/** Dosage forms. Stored as these keys; shown with `PRODUCT_FORM_LABELS`. */
export const PRODUCT_FORMS = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'drops',
  'injection',
  'infusion',
  'cream',
  'ointment',
  'gel',
  'lotion',
  'inhaler',
  'spray',
  'sachet',
  'powder',
  'suppository',
  'device',
  'other',
] as const;

export type ProductForm = (typeof PRODUCT_FORMS)[number];

export const PRODUCT_FORM_LABELS: Record<ProductForm, string> = {
  tablet: 'Tablet',
  capsule: 'Capsule',
  syrup: 'Syrup',
  suspension: 'Suspension',
  drops: 'Drops',
  injection: 'Injection',
  infusion: 'Infusion',
  cream: 'Cream',
  ointment: 'Ointment',
  gel: 'Gel',
  lotion: 'Lotion',
  inhaler: 'Inhaler',
  spray: 'Spray',
  sachet: 'Sachet',
  powder: 'Powder',
  suppository: 'Suppository',
  device: 'Device / surgical',
  other: 'Other',
};

/** The smallest unit a form is usually counted in. */
export const DEFAULT_BASE_UNIT: Record<ProductForm, string> = {
  tablet: 'Tablet',
  capsule: 'Capsule',
  syrup: 'Bottle',
  suspension: 'Bottle',
  drops: 'Bottle',
  injection: 'Injection',
  infusion: 'Bottle',
  cream: 'Tube',
  ointment: 'Tube',
  gel: 'Tube',
  lotion: 'Bottle',
  inhaler: 'Inhaler',
  spray: 'Bottle',
  sachet: 'Sachet',
  powder: 'Pack',
  suppository: 'Suppository',
  device: 'Piece',
  other: 'Piece',
};

/** The usual name of the first pack level above the base unit. */
export function defaultPackUnit(form: ProductForm): string {
  return form === 'tablet' || form === 'capsule' ? 'Strip' : 'Pack';
}

const ALIASES: Record<string, ProductForm> = {
  tab: 'tablet',
  tabs: 'tablet',
  tablets: 'tablet',
  cap: 'capsule',
  caps: 'capsule',
  capsules: 'capsule',
  syp: 'syrup',
  syr: 'syrup',
  susp: 'suspension',
  drop: 'drops',
  'eye drops': 'drops',
  'ear drops': 'drops',
  inj: 'injection',
  injections: 'injection',
  inf: 'infusion',
  crm: 'cream',
  oint: 'ointment',
  inh: 'inhaler',
  sach: 'sachet',
  sachets: 'sachet',
  pwd: 'powder',
  supp: 'suppository',
  supps: 'suppository',
  surgical: 'device',
};

/** Reads a dosage form from import files ("Tab", "CAPS", "Syp" …). */
export function parseForm(input: string): ProductForm | null {
  const key = nameKey(input).replace(/\.$/, '');
  if (!key) return null;
  if ((PRODUCT_FORMS as readonly string[]).includes(key)) return key as ProductForm;
  return ALIASES[key] ?? null;
}
