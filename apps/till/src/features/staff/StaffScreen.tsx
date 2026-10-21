import { ROLE_LABELS, USER_ROLES, type UserRole } from '@app/core';
import {
  createUser,
  listUsers,
  resetUserPin,
  unlockUser,
  updateUser,
  type StaffUser,
} from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useAction, useServices } from '../../app/services';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { S } from '../../strings';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Field,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Select,
  TextInput,
} from '../../ui';
import { PinInput } from '../auth/PinInput';

type Dialog =
  { kind: 'add' } | { kind: 'edit'; user: StaffUser } | { kind: 'pin'; user: StaffUser } | null;

export function StaffScreen() {
  const { ctx } = useServices();
  const users = useQuery({ queryKey: ['users'], queryFn: () => listUsers(ctx) });
  const [dialog, setDialog] = useState<Dialog>(null);
  const unlock = useAction((c, id: string) => unlockUser(c, id));

  return (
    <div className="page">
      <PageHeader
        title={S.staff.title}
        subtitle={S.staff.subtitle}
        actions={
          <Button variant="primary" onClick={() => setDialog({ kind: 'add' })}>
            {S.staff.add}
          </Button>
        }
      />
      {users.isError && <Notice tone="bad">{errorMessage(users.error)}</Notice>}
      {unlock.isError && <Notice tone="bad">{errorMessage(unlock.error)}</Notice>}
      {users.isPending ? (
        <Loading />
      ) : (
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>{S.staff.name}</th>
                <th>{S.staff.role}</th>
                <th>{S.staff.status}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'row-muted'}>
                  <td>
                    {u.name}
                    {u.id === ctx.session.userId && <span className="muted"> ({S.staff.you})</span>}
                  </td>
                  <td>{ROLE_LABELS[u.role]}</td>
                  <td>
                    {u.isActive ? (
                      <Badge tone="good">{S.staff.active}</Badge>
                    ) : (
                      <Badge>{S.staff.switchedOff}</Badge>
                    )}{' '}
                    {u.lockedUntil && <Badge tone="bad">{S.auth.locked}</Badge>}
                    {!u.hasPin && <Badge tone="warn">{S.auth.noPin}</Badge>}
                  </td>
                  <td className="cell-actions">
                    {u.lockedUntil && (
                      <Button size="small" onClick={() => unlock.mutate(u.id)}>
                        {S.staff.unlock}
                      </Button>
                    )}
                    <Button size="small" onClick={() => setDialog({ kind: 'pin', user: u })}>
                      {S.staff.resetPin}
                    </Button>
                    <Button size="small" onClick={() => setDialog({ kind: 'edit', user: u })}>
                      {S.common.edit}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {dialog?.kind === 'add' && <AddPersonDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === 'edit' && (
        <EditPersonDialog user={dialog.user} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'pin' && (
        <ResetPinDialog user={dialog.user} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function RoleSelect({ value, onChange }: { value: UserRole; onChange: (r: UserRole) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as UserRole)}>
      {USER_ROLES.map((r) => (
        <option key={r} value={r}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </Select>
  );
}

function AddPersonDialog({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState({
    name: '',
    role: 'cashier' as UserRole,
    pin: '',
    pinRepeat: '',
  });
  const add = useAction(createUser, { onSuccess: onClose });
  const errors = fieldErrors(add.error);
  const set = (key: 'name' | 'pin' | 'pinRepeat') => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate(values);
  }

  return (
    <Modal title={S.staff.addTitle} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {add.isError && Object.keys(errors).length === 0 && (
          <Notice tone="bad">{errorMessage(add.error)}</Notice>
        )}
        <Field label={S.staff.name} error={errors.name}>
          <TextInput value={values.name} onChange={set('name')} />
        </Field>
        <Field label={S.staff.role} hint={S.staff.roleHelp[values.role]} error={errors.role}>
          <RoleSelect value={values.role} onChange={(role) => setValues((v) => ({ ...v, role }))} />
        </Field>
        <div className="row">
          <Field label={S.staff.pin} hint={S.staff.pinHint} error={errors.pin}>
            <PinInput value={values.pin} onChange={set('pin')} />
          </Field>
          <Field label={S.staff.pinRepeat} error={errors.pinRepeat}>
            <PinInput value={values.pinRepeat} onChange={set('pinRepeat')} />
          </Field>
        </div>
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={add.isPending}>
            {S.common.add}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}

function EditPersonDialog({ user, onClose }: { user: StaffUser; onClose: () => void }) {
  const [values, setValues] = useState({
    name: user.name,
    role: user.role,
    isActive: user.isActive,
  });
  const save = useAction((c, input: typeof values) => updateUser(c, user.id, input), {
    onSuccess: onClose,
  });
  const errors = fieldErrors(save.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    save.mutate(values);
  }

  return (
    <Modal title={S.staff.editTitle(user.name)} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {save.isError && <Notice tone="bad">{errorMessage(save.error)}</Notice>}
        <Field label={S.staff.name} error={errors.name}>
          <TextInput
            value={values.name}
            onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
          />
        </Field>
        <Field label={S.staff.role} hint={S.staff.roleHelp[values.role]} error={errors.role}>
          <RoleSelect value={values.role} onChange={(role) => setValues((v) => ({ ...v, role }))} />
        </Field>
        <Checkbox
          label={S.staff.accountActive}
          checked={values.isActive}
          onChange={(isActive) => setValues((v) => ({ ...v, isActive }))}
        />
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={save.isPending}>
            {S.common.save}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPinDialog({ user, onClose }: { user: StaffUser; onClose: () => void }) {
  const [values, setValues] = useState({ pin: '', pinRepeat: '' });
  const reset = useAction((c, input: typeof values) => resetUserPin(c, user.id, input), {
    onSuccess: onClose,
  });
  const errors = fieldErrors(reset.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    reset.mutate(values);
  }

  return (
    <Modal title={S.staff.resetTitle(user.name)} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {reset.isError && Object.keys(errors).length === 0 && (
          <Notice tone="bad">{errorMessage(reset.error)}</Notice>
        )}
        <div className="row">
          <Field label={S.staff.pin} hint={S.staff.pinHint} error={errors.pin}>
            <PinInput
              value={values.pin}
              onChange={(e) => setValues((v) => ({ ...v, pin: e.target.value }))}
            />
          </Field>
          <Field label={S.staff.pinRepeat} error={errors.pinRepeat}>
            <PinInput
              value={values.pinRepeat}
              onChange={(e) => setValues((v) => ({ ...v, pinRepeat: e.target.value }))}
            />
          </Field>
        </div>
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={reset.isPending}>
            {S.common.save}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}
