import { describe, expect, it } from 'vitest';
import { matchOptions } from './match-options';

const makers = ['Abbott', 'Getz Pharma', 'GSK', 'Highnoon', 'Merck', 'Searle Pharma'];

describe('matchOptions', () => {
  it('offers everything for an empty box', () => {
    expect(matchOptions(makers, '')).toEqual(makers);
    expect(matchOptions(makers, '   ')).toEqual(makers);
  });

  it('puts names that start with the text before names that contain it', () => {
    expect(matchOptions(['Searle Pharma', 'Pharmevo', 'Getz Pharma'], 'pharm')).toEqual([
      'Pharmevo',
      'Searle Pharma',
      'Getz Pharma',
    ]);
  });

  it('ignores case, so a different spelling still offers the saved name', () => {
    expect(matchOptions(makers, 'gsk')).toEqual(['GSK']);
    expect(matchOptions(makers, ' MER ')).toEqual(['Merck']);
  });

  it('leaves out a name typed exactly', () => {
    expect(matchOptions(makers, 'GSK')).toEqual([]);
    expect(matchOptions(['GSK', 'GSK Consumer'], 'GSK')).toEqual(['GSK Consumer']);
  });

  it('returns nothing when no name matches', () => {
    expect(matchOptions(makers, 'zzz')).toEqual([]);
  });

  it('stops at the limit', () => {
    const many = Array.from({ length: 80 }, (_, i) => `Maker ${i}`);
    expect(matchOptions(many, 'maker')).toHaveLength(50);
    expect(matchOptions(many, 'maker', 5)).toEqual(many.slice(0, 5));
  });
});
