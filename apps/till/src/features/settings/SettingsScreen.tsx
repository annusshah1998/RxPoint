import { parseMoney, toMajorString } from '@app/core';
import {
  getStoreDetails,
  getStoreSettings,
  updateStoreDetails,
  updateStoreSettings,
  type StoreDetails,
  type StoreSettings,
} from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useAction, useServices } from '../../app/services';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { S } from '../../strings';
import {
  Card,
  Checkbox,
  Field,
  Loading,
  Notice,
  PageHeader,
  Select,
  TextInput,
  Button,
} from '../../ui';

export function SettingsScreen() {
  const { ctx } = useServices();
  const details = useQuery({ queryKey: ['store-details'], queryFn: () => getStoreDetails(ctx) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => getStoreSettings(ctx) });
  if (!details.data || !settings.data) return <Loading />;
  return (
    <div className="page">
      <PageHeader title={S.settings.title} subtitle={S.settings.subtitle} />
      <StoreDetailsForm initial={details.data} />
      <CheckoutSettingsForm initial={settings.data} />
      <Notice tone="info">{S.settings.printing}</Notice>
    </div>
  );
}

function StoreDetailsForm({ initial }: { initial: StoreDetails }) {
  const [values, setValues] = useState({
    name: initial.name,
    address: initial.address ?? '',
    phone: initial.phone ?? '',
    ntn: initial.ntn ?? '',
    drugLicenseNo: initial.drugLicenseNo ?? '',
  });
  const [saved, setSaved] = useState(false);
  const save = useAction(updateStoreDetails, { onSuccess: () => setSaved(true) });
  const errors = fieldErrors(save.error);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) => {
    setSaved(false);
    setValues((v) => ({ ...v, [key]: e.target.value }));
  };
  return (
    <Card title={S.settings.store}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(values);
        }}
        noValidate
      >
        {save.isError && Object.keys(errors).length === 0 && (
          <Notice tone="bad">{errorMessage(save.error)}</Notice>
        )}
        <Field label={S.settings.name} error={errors.name}>
          <TextInput value={values.name} onChange={set('name')} />
        </Field>
        <Field label={S.settings.address} error={errors.address}>
          <TextInput value={values.address} onChange={set('address')} />
        </Field>
        <div className="row">
          <Field label={S.settings.phone}>
            <TextInput value={values.phone} onChange={set('phone')} inputMode="tel" />
          </Field>
          <Field label={S.settings.drugLicense}>
            <TextInput value={values.drugLicenseNo} onChange={set('drugLicenseNo')} />
          </Field>
          <Field label={S.settings.ntn}>
            <TextInput value={values.ntn} onChange={set('ntn')} />
          </Field>
        </div>
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {S.settings.save}
          </Button>
          {saved && <span className="muted">{S.settings.saved}</span>}
        </div>
      </form>
    </Card>
  );
}

const pct = (bp: number) => String(bp / 100);
const readPct = (text: string) => {
  const n = Number(text.trim());
  return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n * 100) : null;
};
const readInt = (text: string) => {
  const n = Number(text.trim());
  return Number.isInteger(n) ? n : null;
};

function CheckoutSettingsForm({ initial }: { initial: StoreSettings }) {
  const [v, setV] = useState({
    roundingStep: String(initial.rounding.step),
    roundingMode: initial.rounding.mode,
    defaultDiscount: pct(initial.defaultDiscountBp),
    capPharmacist: pct(initial.discountCapBp.pharmacist),
    capCashier: pct(initial.discountCapBp.cashier),
    rxCheck: initial.rxCheck,
    nearExpiryDays: String(initial.saleNearExpiryDays),
    returnDays: String(initial.returnDays),
    defaultFloat: toMajorString(initial.defaultFloat),
    payOutLimit: toMajorString(initial.payOutLimit),
    varianceNoteAt: toMajorString(initial.varianceNoteAt),
    autoLock: String(initial.autoLockMinutes),
    maxHeld: String(initial.maxHeld),
    showBatch: initial.receipt.showBatch,
    showSavings: initial.receipt.showSavings,
    footer: initial.receipt.footer[0] ?? '',
  });
  const [local, setLocal] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction(updateStoreSettings, { onSuccess: () => setSaved(true) });
  const errors = fieldErrors(save.error);
  const text = (key: keyof typeof v) => (e: { target: { value: string } }) => {
    setSaved(false);
    setV((s) => ({ ...s, [key]: e.target.value }));
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const nums = {
      defaultDiscountBp: readPct(v.defaultDiscount),
      pharmacist: readPct(v.capPharmacist),
      cashier: readPct(v.capCashier),
      saleNearExpiryDays: readInt(v.nearExpiryDays),
      returnDays: readInt(v.returnDays),
      defaultFloat: parseMoney(v.defaultFloat),
      payOutLimit: parseMoney(v.payOutLimit),
      varianceNoteAt: parseMoney(v.varianceNoteAt),
      autoLockMinutes: readInt(v.autoLock),
      maxHeld: readInt(v.maxHeld),
    };
    if (Object.values(nums).some((n) => n === null)) {
      setLocal(S.validation.wholeNumber);
      return;
    }
    setLocal(null);
    save.mutate({
      rounding: {
        step: Number(v.roundingStep) as 1 | 50 | 100 | 500 | 1000,
        mode: v.roundingMode,
      },
      defaultDiscountBp: nums.defaultDiscountBp!,
      discountCapBp: {
        ...initial.discountCapBp,
        pharmacist: nums.pharmacist!,
        cashier: nums.cashier!,
      },
      rxCheck: v.rxCheck,
      saleNearExpiryDays: nums.saleNearExpiryDays!,
      returnDays: nums.returnDays!,
      defaultFloat: nums.defaultFloat!,
      payOutLimit: nums.payOutLimit!,
      varianceNoteAt: nums.varianceNoteAt!,
      autoLockMinutes: nums.autoLockMinutes!,
      maxHeld: nums.maxHeld!,
      receipt: {
        showBatch: v.showBatch,
        showSavings: v.showSavings,
        footer: v.footer.trim() ? [v.footer.trim()] : [],
      },
    });
  }

  return (
    <Card title={S.settings.checkout}>
      <form onSubmit={submit} noValidate>
        {(local ?? (save.isError ? errorMessage(save.error) : null)) && (
          <Notice tone="bad">{local ?? errorMessage(save.error)}</Notice>
        )}
        <div className="row">
          <Field label={S.settings.rounding}>
            <Select value={v.roundingStep} onChange={text('roundingStep')}>
              {Object.entries(S.settings.roundingOptions).map(([step, label]) => (
                <option key={step} value={step}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={S.settings.roundingMode}>
            <Select
              value={v.roundingMode}
              onChange={(e) =>
                setV((s) => ({ ...s, roundingMode: e.target.value as 'nearest' | 'down' }))
              }
            >
              <option value="nearest">{S.settings.nearest}</option>
              <option value="down">{S.settings.down}</option>
            </Select>
          </Field>
        </div>
        <div className="row">
          <Field label={S.settings.defaultDiscount} error={errors.defaultDiscountBp}>
            <TextInput
              value={v.defaultDiscount}
              onChange={text('defaultDiscount')}
              inputMode="decimal"
            />
          </Field>
          <Field
            label={S.settings.capPharmacist}
            hint={S.settings.capHint}
            error={errors['discountCapBp.pharmacist']}
          >
            <TextInput
              value={v.capPharmacist}
              onChange={text('capPharmacist')}
              inputMode="decimal"
            />
          </Field>
          <Field label={S.settings.capCashier} error={errors['discountCapBp.cashier']}>
            <TextInput value={v.capCashier} onChange={text('capCashier')} inputMode="decimal" />
          </Field>
        </div>
        <div className="row">
          <Field label={S.settings.rxCheck}>
            <Select
              value={v.rxCheck}
              onChange={(e) =>
                setV((s) => ({ ...s, rxCheck: e.target.value as 'record' | 'require_seen' }))
              }
            >
              <option value="record">{S.settings.rxRecord}</option>
              <option value="require_seen">{S.settings.rxRequire}</option>
            </Select>
          </Field>
          <Field label={S.settings.nearExpiryDays}>
            <TextInput
              value={v.nearExpiryDays}
              onChange={text('nearExpiryDays')}
              inputMode="numeric"
            />
          </Field>
          <Field
            label={S.settings.returnDays}
            hint={S.settings.returnDaysHint}
            error={errors.returnDays}
          >
            <TextInput value={v.returnDays} onChange={text('returnDays')} inputMode="numeric" />
          </Field>
        </div>
        <h3 className="form-section">{S.settings.cash}</h3>
        <div className="row">
          <Field label={S.settings.defaultFloat}>
            <TextInput value={v.defaultFloat} onChange={text('defaultFloat')} inputMode="decimal" />
          </Field>
          <Field label={S.settings.payOutLimit}>
            <TextInput value={v.payOutLimit} onChange={text('payOutLimit')} inputMode="decimal" />
          </Field>
          <Field label={S.settings.varianceNoteAt}>
            <TextInput
              value={v.varianceNoteAt}
              onChange={text('varianceNoteAt')}
              inputMode="decimal"
            />
          </Field>
        </div>
        <div className="row">
          <Field label={S.settings.autoLock}>
            <TextInput value={v.autoLock} onChange={text('autoLock')} inputMode="numeric" />
          </Field>
          <Field label={S.settings.maxHeld}>
            <TextInput value={v.maxHeld} onChange={text('maxHeld')} inputMode="numeric" />
          </Field>
        </div>
        <h3 className="form-section">{S.settings.receipts}</h3>
        <Checkbox
          label={S.settings.showBatch}
          checked={v.showBatch}
          onChange={(showBatch) => setV((s) => ({ ...s, showBatch }))}
        />
        <Checkbox
          label={S.settings.showSavings}
          checked={v.showSavings}
          onChange={(showSavings) => setV((s) => ({ ...s, showSavings }))}
        />
        <Field label={S.settings.footer} hint={S.settings.footerHint}>
          <TextInput value={v.footer} onChange={text('footer')} maxLength={48} />
        </Field>
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {S.settings.save}
          </Button>
          {saved && <span className="muted">{S.settings.saved}</span>}
        </div>
      </form>
    </Card>
  );
}
