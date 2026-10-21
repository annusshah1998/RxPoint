import { parseMoney, type Money } from '@app/core';
import { S } from '../strings';

/** Reads an amount typed in rupees ("1,240" or "1240.50"). Blank is an error unless `optional`. */
export function readMoney(
  text: string,
  options: { optional?: boolean } = {},
): { value: Money | null } | { error: string } {
  if (!text.trim()) return options.optional ? { value: null } : { error: S.validation.badPrice };
  const value = parseMoney(text);
  return value === null ? { error: S.validation.badPrice } : { value };
}
