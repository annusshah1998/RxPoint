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
  /** Restart the clock guard after the PC clock ran ahead and was put right. */
  'clock.reset',
  /** See cost prices and profit. */
  'cost.view',
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
  inventory: new Set<Permission>(['catalog.edit', 'stock.adjust', 'import.run', 'cost.view']),
};

/**
 * Things done at the counter that a cashier may do with a pharmacist's or the owner's PIN.
 * Everything else (back-office work) needs someone with the role to log in themselves.
 */
export const APPROVABLE_PERMISSIONS = [
  'sale.price_override',
  'sale.controlled',
  'sale.void',
  'sale.return',
  'sale.return_late',
  'drawer.no_sale',
  'cash.pay_out_large',
  'clock.reset',
] as const satisfies readonly Permission[];
export type ApprovablePermission = (typeof APPROVABLE_PERMISSIONS)[number];

/** What a PIN approval can cover: an approvable permission, or a discount above the cashier's cap. */
export type ApprovalKind = ApprovablePermission | 'sale.discount';

export function isApprovable(permission: Permission): permission is ApprovablePermission {
  return (APPROVABLE_PERMISSIONS as readonly Permission[]).includes(permission);
}

/** "a pharmacist or the owner", for messages about who can approve. */
export function approverPhrase(roles: readonly UserRole[]): string {
  const words: Record<UserRole, string> = {
    owner: 'the owner',
    pharmacist: 'a pharmacist',
    cashier: 'a cashier',
    inventory: 'an inventory clerk',
  };
  const ordered = [...roles].sort((a, b) => (a === 'owner' ? 1 : b === 'owner' ? -1 : 0));
  const list = ordered.map((r) => words[r]);
  return list.length <= 2 ? list.join(' or ') : `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`;
}

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
