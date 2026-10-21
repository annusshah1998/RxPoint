import { PRODUCT } from '@app/config';
import { setupStore, type ServiceContext, type Session } from '@app/db';
import { useState, type FormEvent } from 'react';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Field, Notice, TextInput } from '../../ui';

export function SetupScreen({
  ctx,
  onDone,
}: {
  ctx: ServiceContext;
  onDone: (session: Session) => void;
}) {
  const [values, setValues] = useState({
    pharmacyName: '',
    address: '',
    phone: '',
    tillCode: 'T1',
    ownerName: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fields = fieldErrors(error);
  const set = (key: keyof typeof values) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await setupStore(ctx, values));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="setup">
      <form className="card setup-card" onSubmit={submit} noValidate>
        <div className="brand brand-large">{PRODUCT.name}</div>
        <h1 className="page-title">{S.setup.title}</h1>
        <p className="muted">{S.setup.intro}</p>
        {error != null && <Notice tone="bad">{errorMessage(error)}</Notice>}
        <Field label={S.setup.pharmacyName} error={fields.pharmacyName}>
          <TextInput value={values.pharmacyName} onChange={set('pharmacyName')} autoFocus />
        </Field>
        <Field label={S.setup.address} error={fields.address}>
          <TextInput value={values.address} onChange={set('address')} />
        </Field>
        <div className="row">
          <Field label={S.setup.phone} error={fields.phone}>
            <TextInput value={values.phone} onChange={set('phone')} inputMode="tel" />
          </Field>
          <Field label={S.setup.tillCode} hint={S.setup.tillCodeHint} error={fields.tillCode}>
            <TextInput value={values.tillCode} onChange={set('tillCode')} maxLength={10} />
          </Field>
        </div>
        <Field label={S.setup.ownerName} error={fields.ownerName}>
          <TextInput value={values.ownerName} onChange={set('ownerName')} />
        </Field>
        <Button type="submit" variant="primary" disabled={busy}>
          {S.setup.submit}
        </Button>
      </form>
    </div>
  );
}
