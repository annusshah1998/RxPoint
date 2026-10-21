import { isAppError } from '@app/core';
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
