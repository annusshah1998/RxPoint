import { USER_ROLES, approverPhrase, can, type Permission, type UserRole } from '@app/core';
import { listLoginUsers } from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useServices } from '../../app/services';
import { S } from '../../strings';
import { Field, Notice, Select } from '../../ui';
import { PinInput } from './PinInput';

export interface ApprovalValue {
  userId: string;
  pin: string;
}

/**
 * Who approves and their PIN, shown inside a dialog when the service answers
 * NEEDS_APPROVAL. The PIN is checked by the service when the action is retried.
 */
export function ApprovalFields({
  permission,
  eligible,
  value,
  onChange,
  errors,
  message,
}: {
  /** Who may approve: anyone with this permission, or those `eligible` allows. */
  permission?: Permission;
  eligible?: (role: UserRole) => boolean;
  value: ApprovalValue;
  onChange: (value: ApprovalValue) => void;
  errors: Record<string, string>;
  /** Replaces "This needs a PIN from …". */
  message?: string;
}) {
  const { ctx } = useServices();
  const users = useQuery({ queryKey: ['login-users'], queryFn: () => listLoginUsers(ctx) });
  const allowed = (role: UserRole) =>
    eligible ? eligible(role) : permission ? can(role, permission) : false;
  const approvers = (users.data ?? []).filter(
    (u) => u.id !== ctx.session.userId && u.hasPin && allowed(u.role),
  );
  const who = approverPhrase(USER_ROLES.filter(allowed));
  const userId = value.userId || approvers[0]?.id || '';

  return (
    <div className="approval-box">
      <Notice tone="warn">{message ?? S.approval.needs(who)}</Notice>
      {users.isSuccess && approvers.length === 0 ? (
        <Notice tone="bad">{S.approval.nobody(who)}</Notice>
      ) : (
        <div className="row">
          <Field label={S.approval.approver} error={errors.userId}>
            <Select value={userId} onChange={(e) => onChange({ ...value, userId: e.target.value })}>
              {approvers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={S.approval.pin} error={errors.pin}>
            <PinInput
              value={value.pin}
              onChange={(e) => onChange({ userId, pin: e.target.value })}
              autoFocus
            />
          </Field>
        </div>
      )}
    </div>
  );
}
