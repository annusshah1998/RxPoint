import { pinProblem } from '@app/core';
import { z } from 'zod';

/** A PIN field in a form: digits only, kept as a string (leading zeros count). */
export const pinText = z.string('Enter the PIN').trim();

/** Adds form errors for a new PIN and its repeat: format, too easy to guess, or not matching. */
export function checkNewPin(
  ctx: z.RefinementCtx,
  pin: string,
  repeat: string,
  options: { owner: boolean; field: string },
): void {
  const problem = pinProblem(pin, { owner: options.owner });
  if (problem === 'format') {
    ctx.addIssue({
      code: 'custom',
      path: [options.field],
      message: options.owner ? 'Use exactly 6 digits' : 'Use 4 to 6 digits',
    });
  } else if (problem === 'weak') {
    ctx.addIssue({
      code: 'custom',
      path: [options.field],
      message: 'Too easy to guess. Avoid repeats and runs like 1234.',
    });
  } else if (pin !== repeat) {
    ctx.addIssue({
      code: 'custom',
      path: [`${options.field}Repeat`],
      message: 'The two PINs don’t match',
    });
  }
}
