import { describe, expect, it } from 'vitest';
import { PERMISSIONS, USER_ROLES, can, rolesThatCan } from './permissions';

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
    expect(table.inventory).toEqual(['catalog.edit', 'stock.adjust', 'import.run']);
    expect(table.pharmacist).not.toContain('users.manage');
    expect(table.pharmacist).not.toContain('backup.restore');
    expect(table.pharmacist).toContain('sale.void');
    expect(table.pharmacist).toContain('sale.controlled');
  });

  it('lists who can approve', () => {
    expect(rolesThatCan('sale.void')).toEqual(['owner', 'pharmacist']);
    expect(rolesThatCan('users.manage')).toEqual(['owner']);
    expect(rolesThatCan('sale.sell')).toEqual(['owner', 'pharmacist', 'cashier']);
  });
});
