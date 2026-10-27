import { CHECKOUT_DEFAULTS } from '@app/config';
import { AppError, USER_ROLES, type Money, type RoundingRule, type UserRole } from '@app/core';
import { z } from 'zod';
import { timestamp, type AppContext, type ServiceContext } from '../context';
import type { Db } from '../executor';
import { META, getMeta, setMeta } from '../meta';
import { parseInput } from '../validation';
import { audit, insertRow, updateRow, type Tx } from '../writes';
import { authorizeTx } from './guards';

// ---------------------------------------------------------------------------
// Store settings (synced: the same for every till in the branch)
// ---------------------------------------------------------------------------

export interface StoreSettings {
  rounding: RoundingRule;
  defaultDiscountBp: number;
  /** Highest discount each role may give without approval (basis points). */
  discountCapBp: Record<UserRole, number>;
  defaultSaleUnit: 'strip' | 'base';
  saleNearExpiryDays: number;
  rxCheck: 'record' | 'require_seen';
  returnDays: number;
  payOutLimit: Money;
  varianceNoteAt: Money;
  defaultFloat: Money;
  autoLockMinutes: number;
  maxHeld: number;
  receipt: { showBatch: boolean; showSavings: boolean; footer: string[] };
}

const bp = z.number().int().min(0).max(10_000);
const money = z.number().int().min(0).max(100_000_000);

/** One schema per key, so a bad stored value falls back to the default for that key only. */
const SETTING_SCHEMAS = {
  rounding: z.object({
    step: z.union([z.literal(1), z.literal(50), z.literal(100), z.literal(500), z.literal(1000)]),
    mode: z.enum(['nearest', 'down']),
  }),
  defaultDiscountBp: bp,
  discountCapBp: z.object(
    Object.fromEntries(USER_ROLES.map((r) => [r, bp])) as Record<UserRole, typeof bp>,
  ),
  defaultSaleUnit: z.enum(['strip', 'base']),
  saleNearExpiryDays: z.number().int().min(0).max(365),
  rxCheck: z.enum(['record', 'require_seen']),
  returnDays: z.number().int().min(0).max(365),
  payOutLimit: money,
  varianceNoteAt: money,
  defaultFloat: money,
  autoLockMinutes: z.number().int().min(1).max(60),
  maxHeld: z.number().int().min(1).max(50),
  receipt: z.object({
    showBatch: z.boolean(),
    showSavings: z.boolean(),
    footer: z.array(z.string().trim().max(48)).max(4),
  }),
} satisfies { [K in keyof StoreSettings]: z.ZodType<StoreSettings[K]> };

type SettingKey = keyof StoreSettings;
const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

export const DEFAULT_STORE_SETTINGS: StoreSettings = {
  ...CHECKOUT_DEFAULTS,
  rounding: { ...CHECKOUT_DEFAULTS.rounding },
  discountCapBp: { ...CHECKOUT_DEFAULTS.discountCapBp },
  receipt: { ...CHECKOUT_DEFAULTS.receipt, footer: [...CHECKOUT_DEFAULTS.receipt.footer] },
};

/** The branch's settings: stored values over the defaults. */
export async function getStoreSettingsTx(db: Db | Tx, branchId: string): Promise<StoreSettings> {
  const rows = await db
    .selectFrom('setting')
    .select(['key', 'value_json'])
    .where('branch_id', '=', branchId)
    .execute();
  const settings = structuredClone(DEFAULT_STORE_SETTINGS) as unknown as Record<string, unknown>;
  for (const row of rows) {
    if (!(row.key in SETTING_SCHEMAS)) continue;
    const schema = SETTING_SCHEMAS[row.key as SettingKey];
    let parsed;
    try {
      parsed = schema.safeParse(JSON.parse(row.value_json));
    } catch {
      parsed = { success: false as const };
    }
    if (parsed.success) settings[row.key] = parsed.data;
    else console.warn(`Ignoring bad setting ${row.key}; using the default`);
  }
  return settings as unknown as StoreSettings;
}

export function getStoreSettings(ctx: AppContext): Promise<StoreSettings> {
  return getStoreSettingsTx(ctx.db, ctx.session.branchId);
}

const storeSettingsPatchSchema = z.object(SETTING_SCHEMAS).partial().strict();

export type StoreSettingsPatch = z.input<typeof storeSettingsPatchSchema>;

/** Changes store settings (owner only). Each changed key is one synced row and audited. */
export async function updateStoreSettings(
  ctx: AppContext,
  input: StoreSettingsPatch,
): Promise<StoreSettings> {
  const patch = parseInput(storeSettingsPatchSchema, input);
  return ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'settings.edit');
    const before = await getStoreSettingsTx(trx, ctx.session.branchId);
    const after = { ...before, ...patch } as StoreSettings;
    for (const role of USER_ROLES) {
      if (role !== 'inventory' && after.discountCapBp[role] < after.defaultDiscountBp) {
        throw new AppError('VALIDATION', 'A cap can’t be below the store’s default discount', {
          [`discountCapBp.${role}`]: 'Below the default discount',
        });
      }
    }

    const now = timestamp(ctx);
    const changed: Partial<Record<SettingKey, { before: unknown; after: unknown }>> = {};
    for (const key of SETTING_KEYS) {
      if (!(key in patch)) continue;
      const value = JSON.stringify(after[key]);
      if (value === JSON.stringify(before[key])) continue;
      changed[key] = { before: before[key], after: after[key] };
      const existing = await trx
        .selectFrom('setting')
        .select('id')
        .where('branch_id', '=', ctx.session.branchId)
        .where('key', '=', key)
        .executeTakeFirst();
      if (existing) {
        await updateRow(trx, now, 'setting', existing.id, { value_json: value });
      } else {
        await insertRow(trx, now, 'setting', {
          id: ctx.newId(),
          branch_id: ctx.session.branchId,
          key,
          value_json: value,
          created_at: now,
          updated_at: now,
        });
      }
    }
    if (Object.keys(changed).length > 0) {
      await audit(trx, ctx, {
        action: 'settings.update',
        entityType: 'branch',
        entityId: ctx.session.branchId,
        before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.before])),
        after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.after])),
      });
    }
    return after;
  });
}

// ---------------------------------------------------------------------------
// Device settings (local to this till: printer, drawer, backup folder)
// ---------------------------------------------------------------------------

export const PRINTER_MODES = ['off', 'windows', 'network'] as const;
export type PrinterMode = (typeof PRINTER_MODES)[number];

const deviceSettingsSchema = z.object({
  printer: z.object({
    mode: z.enum(PRINTER_MODES),
    /** Null means the Windows default printer. */
    printerName: z.string().trim().max(200).nullable(),
    host: z.string().trim().max(100),
    port: z.number().int().min(1).max(65_535),
    columns: z.union([z.literal(48), z.literal(42), z.literal(32)]),
    cut: z.boolean(),
    autoPrint: z.boolean(),
  }),
  drawer: z.object({
    enabled: z.boolean(),
    pin: z.union([z.literal(2), z.literal(5)]),
  }),
  backup: z.object({
    /** A second folder (USB stick, another drive) that gets a copy of each backup. */
    mirrorDir: z.string().trim().max(500).nullable(),
  }),
});

export type DeviceSettings = z.output<typeof deviceSettingsSchema>;

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  printer: {
    mode: 'off',
    printerName: null,
    host: '',
    port: 9100,
    columns: 48,
    cut: true,
    autoPrint: true,
  },
  drawer: { enabled: false, pin: 2 },
  backup: { mirrorDir: null },
};

export function getDeviceSettings(ctx: ServiceContext): Promise<DeviceSettings> {
  return getDeviceSettingsTx(ctx.db);
}

export async function getDeviceSettingsTx(db: Db | Tx): Promise<DeviceSettings> {
  const raw = await getMeta(db, META.deviceSettings);
  if (!raw) return structuredClone(DEFAULT_DEVICE_SETTINGS);
  try {
    const stored = JSON.parse(raw) as Partial<DeviceSettings>;
    const merged = {
      printer: { ...DEFAULT_DEVICE_SETTINGS.printer, ...stored.printer },
      drawer: { ...DEFAULT_DEVICE_SETTINGS.drawer, ...stored.drawer },
      backup: { ...DEFAULT_DEVICE_SETTINGS.backup, ...stored.backup },
    };
    const parsed = deviceSettingsSchema.safeParse(merged);
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the defaults
  }
  console.warn('Ignoring bad device settings; using the defaults');
  return structuredClone(DEFAULT_DEVICE_SETTINGS);
}

const deviceSettingsPatchSchema = z
  .object({
    printer: deviceSettingsSchema.shape.printer.partial(),
    drawer: deviceSettingsSchema.shape.drawer.partial(),
    backup: deviceSettingsSchema.shape.backup.partial(),
  })
  .partial()
  .strict();

export type DeviceSettingsPatch = z.input<typeof deviceSettingsPatchSchema>;

export const MIRROR_DIR_HINT = 'Type the folder’s full path, such as E:\\TillBackups';

/**
 * A full folder path: `E:\…` on Windows, a network share `\\server\share\…`, or `/…` on
 * a developer's Mac or Linux. The desktop app checks the folder itself (backup.rs).
 */
export function isFullFolderPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path) || path.startsWith('/');
}

export async function updateDeviceSettings(
  ctx: AppContext,
  input: DeviceSettingsPatch,
): Promise<DeviceSettings> {
  const patch = parseInput(deviceSettingsPatchSchema, input);
  const before = await getDeviceSettings(ctx);
  const after: DeviceSettings = {
    printer: { ...before.printer, ...patch.printer },
    drawer: { ...before.drawer, ...patch.drawer },
    backup: { ...before.backup, ...patch.backup },
  };
  if (after.printer.mode === 'network' && !after.printer.host) {
    throw new AppError('VALIDATION', 'Enter the printer’s IP address', {
      'printer.host': 'Enter the printer’s IP address',
    });
  }
  // An empty box means no mirror folder.
  after.backup.mirrorDir = after.backup.mirrorDir || null;
  if (after.backup.mirrorDir && !isFullFolderPath(after.backup.mirrorDir)) {
    throw new AppError('VALIDATION', MIRROR_DIR_HINT, { 'backup.mirrorDir': MIRROR_DIR_HINT });
  }
  return ctx.db.transaction().execute(async (trx) => {
    await authorizeTx(trx, ctx, 'settings.edit');
    await setMeta(trx, META.deviceSettings, JSON.stringify(after));
    await audit(trx, ctx, {
      action: 'settings.device',
      entityType: 'device',
      entityId: ctx.session.deviceId,
      before,
      after,
    });
    return after;
  });
}
