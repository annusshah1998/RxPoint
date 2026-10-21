import { PRODUCT } from '@app/config';
import { ROLE_LABELS } from '@app/core';
import {
  listLoginUsers,
  login,
  resetOwnerPinWithRecovery,
  type LoginUser,
  type ServiceContext,
  type Session,
} from '@app/db';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { S } from '../../strings';
import { Badge, Button, Field, Notice, TextInput } from '../../ui';
import { PinInput } from './PinInput';

/** Pick your name, type your PIN. */
export function LoginScreen({
  ctx,
  storeName,
  onLogin,
  onRecovered,
}: {
  ctx: ServiceContext;
  storeName: string;
  onLogin: (session: Session) => void;
  /** After a PIN reset with the recovery code: show the new code. */
  onRecovered: (newCode: string) => void;
}) {
  const [users, setUsers] = useState<LoginUser[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const list = await listLoginUsers(ctx);
    setUsers(list);
    setSelected((current) => current ?? (list.length === 1 ? list[0]!.id : null));
  }, [ctx]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selected) pinRef.current?.focus();
  }, [selected]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(ctx, { userId: selected, pin }));
    } catch (err) {
      setError(err);
      setPin('');
      setBusy(false);
      await refresh();
      pinRef.current?.focus();
    }
  }

  if (recovering) {
    return (
      <RecoverOwnerPin
        ctx={ctx}
        onCancel={() => setRecovering(false)}
        onDone={(code) => {
          setRecovering(false);
          onRecovered(code);
        }}
      />
    );
  }

  const user = users?.find((u) => u.id === selected);
  const fields = fieldErrors(error);
  return (
    <div className="setup">
      <form className="card setup-card login-card" onSubmit={submit} noValidate>
        <div className="brand brand-large">{PRODUCT.name}</div>
        <div className="muted">{storeName}</div>
        <h1 className="page-title">{S.auth.loginTitle}</h1>
        <div className="user-picker" role="group" aria-label={S.auth.loginTitle}>
          {users?.map((u) => (
            <button
              key={u.id}
              type="button"
              className={`user-tile ${u.id === selected ? 'selected' : ''}`}
              aria-pressed={u.id === selected}
              onClick={() => {
                setSelected(u.id);
                setError(null);
                setPin('');
              }}
            >
              <span className="user-name">{u.name}</span>
              <span className="user-role">{ROLE_LABELS[u.role]}</span>
              {u.lockedUntil && <Badge tone="bad">{S.auth.locked}</Badge>}
              {!u.hasPin && <Badge tone="warn">{S.auth.noPin}</Badge>}
            </button>
          ))}
        </div>
        {user && (
          <>
            {error != null && !fields.pin && <Notice tone="bad">{errorMessage(error)}</Notice>}
            <Field label={S.auth.pinFor(user.name)} error={fields.pin}>
              <PinInput ref={pinRef} value={pin} onChange={(e) => setPin(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" disabled={busy || pin.length < 4}>
              {S.auth.logIn}
            </Button>
          </>
        )}
        <div className="login-footer">
          <Button variant="ghost" size="small" onClick={() => setRecovering(true)}>
            {S.auth.forgotOwnerPin}
          </Button>
        </div>
      </form>
    </div>
  );
}

function RecoverOwnerPin({
  ctx,
  onCancel,
  onDone,
}: {
  ctx: ServiceContext;
  onCancel: () => void;
  onDone: (newCode: string) => void;
}) {
  const [values, setValues] = useState({ recoveryCode: '', pin: '', pinRepeat: '' });
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
      const { recoveryCode } = await resetOwnerPinWithRecovery(ctx, values);
      onDone(recoveryCode);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="setup">
      <form className="card setup-card" onSubmit={submit} noValidate>
        <h1 className="page-title">{S.auth.recoveryTitle}</h1>
        <p className="muted">{S.auth.recoveryIntro}</p>
        {error != null && Object.keys(fields).length === 0 && (
          <Notice tone="bad">{errorMessage(error)}</Notice>
        )}
        <Field label={S.auth.recoveryCode} error={fields.recoveryCode}>
          <TextInput
            value={values.recoveryCode}
            onChange={set('recoveryCode')}
            autoComplete="off"
            autoCapitalize="characters"
            autoFocus
          />
        </Field>
        <div className="row">
          <Field label={S.auth.newPin} hint={S.setup.ownerPinHint} error={fields.pin}>
            <PinInput value={values.pin} onChange={set('pin')} />
          </Field>
          <Field label={S.auth.newPinRepeat} error={fields.pinRepeat}>
            <PinInput value={values.pinRepeat} onChange={set('pinRepeat')} />
          </Field>
        </div>
        <div className="card-actions">
          <Button variant="ghost" onClick={onCancel}>
            {S.common.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {S.auth.resetPin}
          </Button>
        </div>
      </form>
    </div>
  );
}
