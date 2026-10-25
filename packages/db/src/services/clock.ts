import { AppError, effectiveToday, type IsoDate } from '@app/core';
import { timestamp, today, type AppContext, type ServiceContext } from '../context';
import { META, setMeta } from '../meta';
import { audit } from '../writes';
import {
  authorizeTx,
  clockBlocks,
  clockMessage,
  clockStateTx,
  resolveApproval,
  type ApprovalInput,
  type ClockState,
} from './guards';

export interface ClockStatusView extends ClockState {
  /** The PC's time when this was checked. */
  now: string;
  /** The PC's date in the store's time zone (business dates use this). */
  today: IsoDate;
  /** The date expiry is checked against: never earlier than the last record's date. */
  expiryToday: IsoDate;
  /** Selling is stopped until the date is fixed. */
  blocks: boolean;
  /** For the banner; '' when the clock looks right. */
  message: string;
}

export async function getClockStatus(ctx: ServiceContext): Promise<ClockStatusView> {
  const state = await clockStateTx(ctx.db, ctx);
  return {
    ...state,
    now: timestamp(ctx),
    today: today(ctx),
    expiryToday: effectiveToday(ctx.now(), state.highWater, ctx.timeZone),
    blocks: clockBlocks(state.check),
    message: clockMessage(ctx, state),
  };
}

/**
 * After the clock ran ahead and was put right, records written meanwhile leave the "last
 * record" time in the future, so expiry checks run days ahead. A pharmacist or the owner
 * confirms today's date and the guard starts again from now.
 */
export async function resetClockGuard(
  ctx: AppContext,
  input: { approval?: ApprovalInput | null } = {},
): Promise<void> {
  const approval = await resolveApproval(ctx, input.approval, 'clock.reset');
  await ctx.db.transaction().execute(async (trx) => {
    const { approvedBy } = await authorizeTx(trx, ctx, 'clock.reset', approval);
    const state = await clockStateTx(trx, ctx);
    if (clockBlocks(state.check)) {
      throw new AppError('CLOCK_WRONG', clockMessage(ctx, state));
    }
    if (state.check.status !== 'behind') {
      throw new AppError(
        'INVALID_STATE',
        'The clock isn’t behind the last record; nothing to reset',
      );
    }
    const now = timestamp(ctx);
    await setMeta(trx, META.clockHighWater, now);
    await audit(trx, ctx, {
      action: 'clock.reset',
      entityType: 'device',
      entityId: ctx.session.deviceId,
      before: { highWater: state.highWater },
      after: { highWater: now },
      approvedBy,
    });
  });
}
