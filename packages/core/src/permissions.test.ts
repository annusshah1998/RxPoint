import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  USER_ROLES,
  approverPhrase,
  can,
  isApprovable,
  rolesThatCan,
} from './permissions';

describe('permissions', () => {
  it('matches the agreed role table', () => {
    const table = Object.fromEntries(
      USER_ROLES.map((role) => [role, PERMISSIONS.filter((p) => can(role, p))]),
    );
    expect(table.owner).toEqual([...PERMISSIONS]);
    expect(table.cashier).toEqual([
      'sale.sell',
      'sale.reprint',
      'shift.open',
      'shift.close',
      'cash.pay_in',
      'cash.pay_out',
      'backup.run',
    ]);
    expect(table.inventory).toEqual(['catalog.edit', 'stock.adjust', 'import.run', 'cost.view']);
    expect(table.pharmacist).toContain('clock.reset');
    expect(table.pharmacist).toContain('cost.view');
    expect(table.cashier).not.toContain('cost.view');
    expect(table.pharmacist).not.toContain('users.manage');
    expect(table.pharmacist).not.toContain('backup.restore');
    expect(table.pharmacist).toContain('sale.void');
    expect(table.pharmacist).toContain('sale.controlled');
  });

  it('lists who can approve', () => {
    expect(rolesThatCan('sale.void')).toEqual(['owner', 'pharmacist']);
    expect(rolesThatCan('users.manage')).toEqual(['owner']);
    expect(rolesThatCan('sale.sell')).toEqual(['owner', 'pharmacist', 'cashier']);
    expect(approverPhrase(rolesThatCan('sale.void'))).toBe('a pharmacist or the owner');
    expect(approverPhrase(rolesThatCan('users.manage'))).toBe('the owner');
  });

  it('lets counter work be approved by PIN, but not back-office work', () => {
    expect(isApprovable('sale.void')).toBe(true);
    expect(isApprovable('cash.pay_out_large')).toBe(true);
    expect(isApprovable('catalog.edit')).toBe(false);
    expect(isApprovable('users.manage')).toBe(false);
    // Every approvable permission has someone above a cashier who can give it.
    for (const p of PERMISSIONS.filter(isApprovable)) {
      expect(can('owner', p)).toBe(true);
      expect(can('cashier', p)).toBe(false);
    }
  });
});
