import { describe, expect, it } from 'vitest';
import { divRound, formatMoney, parseMoney, percentOf, roundToStep, toMajorString } from './money';

describe('divRound', () => {
  it('rounds halves away from zero', () => {
    expect(divRound(5, 2)).toBe(3);
    expect(divRound(-5, 2)).toBe(-3);
    expect(divRound(4, 3)).toBe(1);
    expect(divRound(5, 3)).toBe(2);
    expect(divRound(-4, 3)).toBe(-1);
    expect(divRound(10, 5)).toBe(2);
    expect(divRound(0, 7)).toBe(0);
  });

  it('rejects non-integers and zero', () => {
    expect(() => divRound(1.5, 2)).toThrow();
    expect(() => divRound(1, 0)).toThrow();
  });
});

describe('roundToStep', () => {
  it('rounds a bill to the nearest rupee', () => {
    expect(roundToStep(24549, 100)).toBe(24500);
    expect(roundToStep(24550, 100)).toBe(24600);
    expect(roundToStep(-150, 100)).toBe(-200);
  });
});

describe('percentOf', () => {
  it('takes basis points of an amount', () => {
    expect(percentOf(24567, 1000)).toBe(2457); // 10% of Rs 245.67
    expect(percentOf(100, 1250)).toBe(13); // 12.5% of Rs 1.00
  });
});

describe('parseMoney', () => {
  it('parses plain and formatted amounts', () => {
    expect(parseMoney('245.67')).toBe(24567);
    expect(parseMoney('245.6')).toBe(24560);
    expect(parseMoney('245.')).toBe(24500);
    expect(parseMoney('245')).toBe(24500);
    expect(parseMoney('1,250')).toBe(125000);
    expect(parseMoney('Rs 99.5')).toBe(9950);
    expect(parseMoney('rs.10')).toBe(1000);
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('-12.30')).toBe(-1230);
  });

  it('rejects anything else', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('1.2.3')).toBeNull();
  });
});

describe('formatting', () => {
  it('formats for display', () => {
    expect(formatMoney(123456789)).toBe('Rs 1,234,567.89');
    expect(formatMoney(5)).toBe('Rs 0.05');
    expect(formatMoney(-1230)).toBe('-Rs 12.30');
    expect(formatMoney(24567, { symbol: false })).toBe('245.67');
  });

  it('formats for inputs', () => {
    expect(toMajorString(24500)).toBe('245.00');
    expect(toMajorString(-5)).toBe('-0.05');
  });
});
