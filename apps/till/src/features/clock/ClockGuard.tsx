import { PRODUCT } from '@app/config';
import { can, formatDate } from '@app/core';
import { getClockStatus, resetClockGuard, type ClockStatusView } from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useState, type FormEvent } from 'react';
import { useAction, useServices } from '../../app/services';
import { approvalNeeded, errorMessage, fieldErrors, isApprovalError } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Modal, Notice } from '../../ui';
import { ApprovalFields, type ApprovalValue } from '../auth/ApprovalFields';
import { formatDateTime, roughDuration } from './clock-view';

/**
 * The PC clock as the guard sees it. Checked again every minute (every few seconds while
 * the date is wrong, so the block lifts soon after Windows is fixed) and after every write.
 */
export function useClockStatus() {
  const { ctx } = useServices();
  return useQuery({
    queryKey: ['clock'],
    queryFn: () => getClockStatus(ctx),
    refetchInterval: (query) => (query.state.data?.blocks ? 5_000 : 60_000),
  });
}

/** A date that can't be right: nothing can be recorded until Windows has the right date. */
export function ClockBlockScreen({
  status,
  onCheck,
}: {
  status: ClockStatusView;
  onCheck: () => void;
}) {
  const { store, lock } = useServices();
  return (
    <div className="clock-block">
      <div className="clock-block-card" role="alert">
        <div className="muted">
          {PRODUCT.name} · {store.branchName}
        </div>
        <h1>{S.clock.blockTitle}</h1>
        <p>{S.clock.blockText(formatDate(status.today))}</p>
        <p>{S.clock.blockWho}</p>
        <p className="muted">{S.clock.blockWhy}</p>
        <p className="muted">{S.clock.blockLifts}</p>
        <div className="form-actions">
          <Button variant="primary" onClick={onCheck} autoFocus>
            {S.clock.checkAgain}
          </Button>
          <Button variant="ghost" onClick={() => void lock()}>
            {S.auth.lock}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The clock reads behind the last record: selling goes on, with a way to reset the check. */
export function ClockBanner({ status }: { status: ClockStatusView }) {
  const { ctx } = useServices();
  const [resetting, setResetting] = useState(false);
  const close = useCallback(() => setResetting(false), []);
  if (status.check.status !== 'behind' || !status.highWater) return null;
  const by = roughDuration(status.check.byMs);
  return (
    <div className="clock-banner" role="status">
      <div>
        <strong>{S.clock.behindTitle(S.clock.duration(by.n, by.unit))}</strong>{' '}
        {S.clock.behindText(
          formatDateTime(status.now, ctx.timeZone),
          formatDateTime(status.highWater, ctx.timeZone),
        )}
      </div>
      <Button size="small" onClick={() => setResetting(true)}>
        {S.clock.reset}
      </Button>
      {resetting && <ResetClockDialog status={status} onClose={close} />}
    </div>
  );
}

const noApproval: ApprovalValue = { userId: '', pin: '' };

/**
 * After a forward jump was put right, records written meanwhile keep expiry checks days
 * ahead. A pharmacist or the owner confirms the clock is right; a cashier needs their PIN.
 */
function ResetClockDialog({ status, onClose }: { status: ClockStatusView; onClose: () => void }) {
  const { ctx, store } = useServices();
  const [approval, setApproval] = useState<ApprovalValue>(noApproval);
  const [needsApproval, setNeedsApproval] = useState(!can(store.userRole, 'clock.reset'));
  const reset = useAction(resetClockGuard, { onSuccess: onClose });

  function submit(e: FormEvent) {
    e.preventDefault();
    reset.mutate(
      { approval: needsApproval ? approval : null },
      {
        onError: (error) => {
          if (approvalNeeded(error)) setNeedsApproval(true);
        },
      },
    );
  }

  const errors = fieldErrors(reset.error);
  const approvalError = isApprovalError(reset.error);
  return (
    <Modal title={S.clock.resetTitle} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        {reset.isError && !approvalNeeded(reset.error) && !approvalError && (
          <Notice tone="bad">{errorMessage(reset.error)}</Notice>
        )}
        <p>{S.clock.resetIntro(formatDateTime(status.now, ctx.timeZone))}</p>
        {status.expiryToday !== status.today && (
          <p>{S.clock.resetExpiry(formatDate(status.expiryToday), formatDate(status.today))}</p>
        )}
        {needsApproval && (
          <ApprovalFields
            permission="clock.reset"
            value={approval}
            onChange={setApproval}
            errors={approvalError ? errors : {}}
          />
        )}
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={reset.isPending}>
            {S.clock.resetConfirm}
          </Button>
          <Button onClick={onClose}>{S.common.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}
