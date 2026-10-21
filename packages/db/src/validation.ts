import { AppError } from '@app/core';
import { z } from 'zod';

/** Optional free text: trimmed, blank becomes null. */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters`)
    .nullish()
    .transform((value) => (value ? value.replace(/\s+/g, ' ') : null));
}

/** Required free text: trimmed, whitespace collapsed. */
export function requiredText(max: number, message: string) {
  return z
    .string(message)
    .trim()
    .min(1, message)
    .max(max, `Use at most ${max} characters`)
    .transform((value) => value.replace(/\s+/g, ' '));
}

/** Parses service input, turning schema problems into a staff-readable AppError. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw validationError(result.error);
}

export function validationError(error: z.ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join('.') || '_';
    fields[path] ??= issue.message;
  }
  const first = Object.values(fields)[0] ?? 'Please check the form';
  return new AppError('VALIDATION', first, fields);
}
