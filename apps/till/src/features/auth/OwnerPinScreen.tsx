import { PRODUCT } from '@app/config';
import { setInitialOwnerPin, type ServiceContext, type Session } from '@app/db';
import { useState, type FormEvent } from 'react';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Field, Notice } from '../../ui';
import { PinInput } from './PinInput';

/** For a till set up before PIN login: the owner chooses a PIN. */
export function OwnerPinScreen({
  ctx,
  onDone,
}: {
  ctx: ServiceContext;
  onDone: (result: { session: Session; recoveryCode: string }) => void;
}) {
  const [values, setValues] = useState({ pin: '', pinRepeat: '' });
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
      onDone(await setInitialOwnerPin(ctx, values));
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="setup">
      <form className="card setup-card" onSubmit={submit} noValidate>
        <div className="brand brand-large">{PRODUCT.name}</div>
        <h1 className="page-title">{S.auth.ownerPinTitle}</h1>
        <p className="muted">{S.auth.ownerPinIntro}</p>
        {error != null && Object.keys(fields).length === 0 && (
          <Notice tone="bad">{errorMessage(error)}</Notice>
        )}
        <div className="row">
          <Field label={S.setup.ownerPin} hint={S.setup.ownerPinHint} error={fields.pin}>
            <PinInput value={values.pin} onChange={set('pin')} autoFocus />
          </Field>
          <Field label={S.setup.ownerPinRepeat} error={fields.pinRepeat}>
            <PinInput value={values.pinRepeat} onChange={set('pinRepeat')} />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={busy}>
          {S.auth.setPin}
        </Button>
      </form>
    </div>
  );
}
