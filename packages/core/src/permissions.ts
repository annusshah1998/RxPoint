/** Staff roles. Stored as these keys on app_user.role. */
export const USER_ROLES = ['owner', 'pharmacist', 'cashier', 'inventory'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Owner',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
  inventory: 'Inventory clerk',
};

export const PERMISSIONS = [
  // Selling
  'sale.sell',
  'sale.price_override',
  'sale.controlled',
  'sale.void',
  'sale.return',
  'sale.return_late',
  'sale.reprint',
  // Drawer, shift and cash
  'drawer.no_sale',
  'shift.open',
  'shift.close',
  'shift.view_expected',
  'cash.pay_in',
  'cash.pay_out',
  'cash.pay_out_large',
  // Back office
  'catalog.edit',
  'stock.adjust',
  'import.run',
  'users.manage',
  'settings.edit',
  'backup.run',
  'backup.restore',
  'audit.view',
  'clock.override',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const PHARMACIST_EXCLUDED: readonly Permission[] = [
  'users.manage',
  'settings.edit',
  'backup.restore',
  'audit.view',
  'sale.return_late',
];

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  pharmacist: new Set(PERMISSIONS.filter((p) => !PHARMACIST_EXCLUDED.includes(p))),
  cashier: new Set<Permission>([
    'sale.sell',
    'sale.reprint',
    'shift.open',
    'shift.close',
    'cash.pay_in',
    'cash.pay_out',
    'backup.run',
  ]),
  inventory: new Set<Permission>(['catalog.edit', 'stock.adjust', 'import.run']),
};

/** Whether a role may do something without anyone else's approval. */
export function can(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

/** Roles that may approve `permission` for someone else. */
export function rolesThatCan(permission: Permission): UserRole[] {
  return USER_ROLES.filter((role) => can(role, permission));
}
