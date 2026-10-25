import { isAppError, type Permission } from '@app/core';
import { S } from '../strings';

/** A message staff can read. Unexpected errors are logged and get a generic message. */
export function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  if (error) console.error(error);
  return S.common.unexpectedError;
}

/** Field-level problems from a service error, keyed by field path (e.g. "units.1.qty"). */
export function fieldErrors(error: unknown): Record<string, string> {
  return isAppError(error) ? error.fields : {};
}

/** When a service asks for a PIN approval: which permission. */
export function approvalNeeded(error: unknown): Permission | null {
  if (!isAppError(error) || error.code !== 'NEEDS_APPROVAL') return null;
  const permission = error.details.permission;
  return typeof permission === 'string' ? (permission as Permission) : null;
}

/** Every permission an approval must cover (a return can need several at once). */
export function approvalPermissions(error: unknown): Permission[] | null {
  if (!isAppError(error) || error.code !== 'NEEDS_APPROVAL') return null;
  const list = error.details.permissions;
  if (Array.isArray(list) && list.length > 0) return list as Permission[];
  const one = approvalNeeded(error);
  return one ? [one] : null;
}

/** Approval PIN problems (wrong PIN, can't approve) belong to the approval fields. */
export function isApprovalError(error: unknown): boolean {
  return isAppError(error) && ('userId' in error.fields || 'pin' in error.fields);
}
