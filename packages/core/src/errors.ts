export type AppErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'BARCODE_TAKEN'
  | 'NOT_SET_UP'
  | 'INVALID_STATE'
  /** The acting user's role can't do this at all. */
  | 'FORBIDDEN'
  /** Allowed with a PIN approval from someone who can; `details.permission` says what. */
  | 'NEEDS_APPROVAL'
  | 'WRONG_PIN'
  | 'LOCKED'
  /** Selling needs an open shift. */
  | 'NO_SHIFT'
  /** The cashier must confirm something first (e.g. selling when only expired stock is on record). */
  | 'NEEDS_CONFIRMATION'
  /** Prices or stock changed since the screen last priced the sale. */
  | 'TOTAL_CHANGED'
  | 'CLOCK_WRONG'
  /** Not in this version or on this platform (e.g. khata before M4, backups in the browser). */
  | 'NOT_AVAILABLE';

/**
 * An error whose message is safe to show to staff as-is.
 * Anything else that is thrown is a bug and gets a generic message in the UI.
 */
export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Field-level problems, keyed by field path (e.g. "units.1.qty"). */
  readonly fields: Record<string, string>;
  /** Extra data the UI needs to react, e.g. which permission an approval needs. */
  readonly details: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    message: string,
    fields: Record<string, string> = {},
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fields = fields;
    this.details = details;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
