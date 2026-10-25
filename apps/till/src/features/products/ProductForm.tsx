import {
  PRODUCT_FORMS,
  PRODUCT_FORM_LABELS,
  defaultPackUnit,
  describeUnitLadder,
  formatMoney,
  marginBasisPoints,
  parseMoney,
  pluralize,
  pricePerUnit,
  type ProductForm as Form,
} from '@app/core';
import type { TaxClass } from '@app/db';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { S } from '../../strings';
import { Button, Card, Checkbox, Combobox, Field, Select, TextArea, TextInput } from '../../ui';
import { changeForm, rowKey, type ProductFormState, type UnitRow } from './form-state';

export interface ProductFormLists {
  manufacturers: string[];
  generics: string[];
  taxClasses: TaxClass[];
}

const SCHEDULES = ['B', 'D'];

export function ProductForm({
  state,
  setState,
  errors,
  lists,
}: {
  state: ProductFormState;
  setState: Dispatch<SetStateAction<ProductFormState>>;
  errors: Record<string, string>;
  lists: ProductFormLists;
}) {
  const set =
    <K extends keyof ProductFormState>(key: K) =>
    (value: ProductFormState[K]) =>
      setState((s) => ({ ...s, [key]: value }));
  const text = (key: keyof ProductFormState) => ({
    value: state[key] as string,
    onChange: (e: { target: { value: string } }) =>
      setState((s) => ({ ...s, [key]: e.target.value })),
  });

  const baseName = state.units[0]?.name.trim() || 'unit';
  const basePlural = pluralize(baseName, 2).toLowerCase();
  const validUnits = state.units
    .map((u) => ({ name: u.name.trim(), qty: Number(u.qty) }))
    .filter((u) => u.name && Number.isInteger(u.qty) && u.qty > 0);
  const priceUnitName = validUnits.find((u) => String(u.qty) === state.priceQty)?.name ?? baseName;

  return (
    <div className="form-grid">
      <div className="form-column">
        <Card title={S.product.sections.basics}>
          <Field label={S.product.name} error={errors.name}>
            <TextInput {...text('name')} autoFocus />
          </Field>
          <div className="row">
            <Field label={S.product.strength} hint={S.product.strengthHint} error={errors.strength}>
              <TextInput {...text('strength')} />
            </Field>
            <Field label={S.product.form} error={errors.form}>
              <Select
                value={state.form}
                onChange={(e) => setState((s) => changeForm(s, e.target.value as Form))}
              >
                {PRODUCT_FORMS.map((form) => (
                  <option key={form} value={form}>
                    {PRODUCT_FORM_LABELS[form]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label={S.product.manufacturer} error={errors.manufacturer}>
            <Combobox
              value={state.manufacturer}
              onChange={set('manufacturer')}
              options={lists.manufacturers}
            />
          </Field>
        </Card>

        <SaltsCard state={state} setState={setState} errors={errors} generics={lists.generics} />

        <Card title={S.product.sections.pharmacy}>
          <Field label={S.product.controlled} hint={S.product.controlledHint}>
            <Select
              value={state.controlledSchedule}
              onChange={(e) => set('controlledSchedule')(e.target.value)}
            >
              <option value="">{S.product.notControlled}</option>
              {[
                ...SCHEDULES,
                ...(state.controlledSchedule && !SCHEDULES.includes(state.controlledSchedule)
                  ? [state.controlledSchedule]
                  : []),
              ].map((s) => (
                <option key={s} value={s}>
                  {S.product.schedule(s)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="field">
            <Checkbox
              label={S.product.rxRequired}
              checked={state.rxRequired || state.controlledSchedule !== ''}
              disabled={state.controlledSchedule !== ''}
              onChange={set('rxRequired')}
            />
            <Checkbox
              label={S.product.allowDiscount}
              checked={state.allowDiscount}
              onChange={set('allowDiscount')}
            />
          </div>
          <div className="row">
            <Field label={S.product.rack} error={errors.rack}>
              <TextInput {...text('rack')} />
            </Field>
            <Field label={S.product.reorderLevel(basePlural)} error={errors.reorderLevel}>
              <TextInput {...text('reorderLevel')} inputMode="numeric" />
            </Field>
          </div>
          <Field label={S.product.notes} error={errors.notes}>
            <TextArea {...text('notes')} />
          </Field>
        </Card>
      </div>

      <div className="form-column">
        <UnitsCard state={state} setState={setState} errors={errors} basePlural={basePlural} />

        <Card title={S.product.sections.pricing}>
          <div className="row">
            <Field label={S.product.salePrice} error={errors.salePrice}>
              <MoneyInput {...text('salePrice')} />
            </Field>
            <Field label={S.product.pricePer} error={errors.priceQty}>
              <Select value={state.priceQty} onChange={(e) => set('priceQty')(e.target.value)}>
                {validUnits.map((u) => (
                  <option key={u.qty} value={String(u.qty)}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="row">
            <Field
              label={`${S.product.costPrice} (${S.product.pricePer} ${priceUnitName})`}
              error={errors.costPrice}
            >
              <MoneyInput {...text('costPrice')} />
            </Field>
            <Field label={S.product.taxClass} error={errors.taxClassId}>
              <Select value={state.taxClassId} onChange={(e) => set('taxClassId')(e.target.value)}>
                <option value="">{S.product.noTaxClass}</option>
                {lists.taxClasses.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <PricePreview state={state} units={validUnits} />
        </Card>
      </div>
    </div>
  );
}

function MoneyInput(props: {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
}) {
  return (
    <div className="money-input">
      <span className="money-prefix">Rs</span>
      <TextInput {...props} inputMode="decimal" placeholder="0.00" />
    </div>
  );
}

function PricePreview({
  state,
  units,
}: {
  state: ProductFormState;
  units: { name: string; qty: number }[];
}) {
  const sale = parseMoney(state.salePrice);
  const perQty = Number(state.priceQty);
  if (sale === null || !Number.isInteger(perQty) || perQty < 1 || units.length === 0) return null;
  const cost = parseMoney(state.costPrice);
  const margin = marginBasisPoints(
    { amount: sale, perQty },
    cost === null ? null : { amount: cost, perQty },
  );
  return (
    <div className="price-preview">
      <div className="muted">{S.product.unitPrices}</div>
      <ul>
        {pricePerUnit({ amount: sale, perQty }, units).map(({ unit, amount }) => (
          <li key={unit.qty}>
            <span>1 {unit.name}</span>
            <strong>{formatMoney(amount)}</strong>
          </li>
        ))}
      </ul>
      {margin !== null && (
        <div className={margin < 0 ? 'text-bad' : 'muted'}>
          {S.product.margin}: {(margin / 100).toFixed(1)}%
        </div>
      )}
    </div>
  );
}

function UnitsCard({
  state,
  setState,
  errors,
  basePlural,
}: {
  state: ProductFormState;
  setState: Dispatch<SetStateAction<ProductFormState>>;
  errors: Record<string, string>;
  basePlural: string;
}) {
  const update = (key: string, patch: Partial<UnitRow>) =>
    setState((s) => ({
      ...s,
      units: s.units.map((u) => (u.key === key ? { ...u, ...patch } : u)),
    }));
  const remove = (key: string) =>
    setState((s) => {
      const units = s.units.filter((u) => u.key !== key);
      const priceStillValid = units.some((u) => u.qty === s.priceQty);
      return {
        ...s,
        units,
        priceQty: priceStillValid ? s.priceQty : (units[units.length - 1]?.qty ?? '1'),
      };
    });
  const add = () =>
    setState((s) => ({
      ...s,
      units: [
        ...s.units,
        {
          key: rowKey(),
          name: s.units.length === 1 ? defaultPackUnit(s.form) : 'Box',
          qty: '',
          isSellable: true,
          barcodes: '',
        },
      ],
    }));
  // Scanners end with Enter; keep it from submitting the form.
  const onBarcodeKey = (unit: UnitRow) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (unit.barcodes.trim() && !unit.barcodes.trim().endsWith(',')) {
      update(unit.key, { barcodes: `${unit.barcodes.trim()}, ` });
    }
  };

  const ladder = describeUnitLadder(
    state.units
      .map((u) => ({ name: u.name.trim(), qty: Number(u.qty) }))
      .filter((u) => u.name && Number.isInteger(u.qty) && u.qty > 0),
  );

  return (
    <Card title={S.product.sections.units}>
      {errors.units && <div className="field-error">{errors.units}</div>}
      <table className="table table-compact units-table">
        <thead>
          <tr>
            <th>{S.product.unitName}</th>
            <th>{S.product.unitHolds(basePlural)}</th>
            <th>{S.product.sellable}</th>
            <th>{S.product.barcodes}</th>
            <th aria-label={S.common.remove} />
          </tr>
        </thead>
        <tbody>
          {state.units.map((unit, i) => {
            const err = (field: string) => errors[`units.${unit.key}.${field}`];
            return (
              <tr key={unit.key}>
                <td>
                  <TextInput
                    aria-label={`${S.product.unitName} ${i + 1}`}
                    value={unit.name}
                    onChange={(e) => update(unit.key, { name: e.target.value })}
                  />
                  {err('name') && <div className="field-error">{err('name')}</div>}
                </td>
                <td>
                  {i === 0 ? (
                    <span className="muted" title={S.product.baseUnitNote}>
                      1
                    </span>
                  ) : (
                    <TextInput
                      aria-label={`${S.product.unitHolds(basePlural)} ${i + 1}`}
                      className="input-narrow"
                      inputMode="numeric"
                      value={unit.qty}
                      onChange={(e) => update(unit.key, { qty: e.target.value })}
                    />
                  )}
                  {err('qty') && <div className="field-error">{err('qty')}</div>}
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${S.product.sellable} ${unit.name}`}
                    checked={unit.isSellable}
                    onChange={(e) => update(unit.key, { isSellable: e.target.checked })}
                  />
                </td>
                <td>
                  <TextInput
                    aria-label={`${S.product.barcodes} ${unit.name}`}
                    value={unit.barcodes}
                    placeholder={S.product.barcodesHint}
                    onChange={(e) => update(unit.key, { barcodes: e.target.value })}
                    onKeyDown={onBarcodeKey(unit)}
                  />
                  {err('barcodes') && <div className="field-error">{err('barcodes')}</div>}
                </td>
                <td>
                  {i > 0 && (
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`${S.common.remove} ${unit.name}`}
                      onClick={() => remove(unit.key)}
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="card-footer-row">
        <Button size="small" onClick={add} disabled={state.units.length >= 6}>
          + {S.product.addPack}
        </Button>
        {ladder && <span className="muted">{ladder}</span>}
      </div>
    </Card>
  );
}

function SaltsCard({
  state,
  setState,
  errors,
  generics,
}: {
  state: ProductFormState;
  setState: Dispatch<SetStateAction<ProductFormState>>;
  errors: Record<string, string>;
  generics: string[];
}) {
  const update = (key: string, patch: { generic?: string; strength?: string }) =>
    setState((s) => ({
      ...s,
      salts: s.salts.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    }));
  return (
    <Card title={S.product.sections.salts}>
      {state.salts.length === 0 && <p className="muted">{S.product.noSalts}</p>}
      {state.salts.map((salt, i) => (
        <div className="row salt-row" key={salt.key}>
          <Field
            label={`${S.product.generic} ${i + 1}`}
            error={errors[`salts.${salt.key}.generic`]}
          >
            <Combobox
              value={salt.generic}
              onChange={(generic) => update(salt.key, { generic })}
              options={generics}
            />
          </Field>
          <Field label={S.product.genericStrength} error={errors[`salts.${salt.key}.strength`]}>
            <TextInput
              value={salt.strength}
              onChange={(e) => update(salt.key, { strength: e.target.value })}
            />
          </Field>
          <button
            type="button"
            className="icon-btn salt-remove"
            aria-label={`${S.common.remove} ${salt.generic || i + 1}`}
            onClick={() =>
              setState((s) => ({ ...s, salts: s.salts.filter((r) => r.key !== salt.key) }))
            }
          >
            ×
          </button>
        </div>
      ))}
      <Button
        size="small"
        onClick={() =>
          setState((s) => ({
            ...s,
            salts: [...s.salts, { key: rowKey(), generic: '', strength: '' }],
          }))
        }
      >
        + {S.product.addSalt}
      </Button>
    </Card>
  );
}
