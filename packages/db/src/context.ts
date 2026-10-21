import { MARKET } from '@app/config';
import { localDate, uuidv7, type IsoDate } from '@app/core';
import type { Db } from './executor';

/** Who is acting, on which till, in which branch. */
export interface Session {
  branchId: string;
  deviceId: string;
  userId: string;
}

/** Everything a service needs. Clock and id generator are injectable for tests. */
export interface ServiceContext {
  db: Db;
  now: () => Date;
  newId: () => string;
  timeZone: string;
}

export interface AppContext extends ServiceContext {
  session: Session;
}

export function createServiceContext(
  db: Db,
  overrides: Partial<Omit<ServiceContext, 'db'>> = {},
): ServiceContext {
  return {
    db,
    now: overrides.now ?? (() => new Date()),
    newId: overrides.newId ?? (() => uuidv7()),
    timeZone: overrides.timeZone ?? MARKET.timeZone,
  };
}

export function withSession(ctx: ServiceContext, session: Session): AppContext {
  return { ...ctx, session };
}

export function timestamp(ctx: ServiceContext): string {
  return ctx.now().toISOString();
}

/** Today's date in the store's time zone. */
export function today(ctx: ServiceContext): IsoDate {
  return localDate(ctx.now(), ctx.timeZone);
}
