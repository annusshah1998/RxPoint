import { MARKET } from '@app/config';
import { PIN_ITERATIONS, localDate, uuidv7, type IsoDate } from '@app/core';
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
  /** PBKDF2 iterations for new PIN hashes (tests use fewer to run fast). */
  pinIterations: number;
  /** When this build was made: a clock earlier than this is certainly wrong. */
  buildTime: Date;
}

/** Used when the build doesn't say when it was made. */
const EARLIEST_BUILD = new Date('2026-10-01T00:00:00Z');

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
    pinIterations: overrides.pinIterations ?? PIN_ITERATIONS,
    buildTime: overrides.buildTime ?? EARLIEST_BUILD,
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
