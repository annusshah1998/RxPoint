export type AppErrorCode =
  'VALIDATION' | 'NOT_FOUND' | 'DUPLICATE' | 'BARCODE_TAKEN' | 'NOT_SET_UP' | 'INVALID_STATE';

/**
 * An error whose message is safe to show to staff as-is.
 * Anything else that is thrown is a bug and gets a generic message in the UI.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Field-level problems, keyed by field path (e.g. "units.1.qty"). */
  readonly fields: Record<string, string>;

  constructor(code: AppErrorCode, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fields = fields;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
