import { describe, expect, it, vi } from 'vitest';
import type { SendResult } from '../../platform/printer';
import { PrintJobs } from './print-jobs';

/** An attempt that answers only when the test says so. */
function deferred() {
  let answer!: (result: SendResult) => void;
  const attempt = vi.fn(() => new Promise<SendResult>((resolve) => (answer = resolve)));
  return { attempt, answer: (result: SendResult) => answer(result) };
}

const receipt = { kind: 'receipt' as const, title: 'Receipt T1-000001', doc: null };

describe('PrintJobs', () => {
  it('reports a job as printing, then sent, and records the result', async () => {
    const jobs = new PrintJobs();
    const onResult = vi.fn(async () => {});
    const id = jobs.start(receipt, { attempt: async () => ({ ok: true }), onResult });
    expect(jobs.get(id)).toMatchObject({ status: 'printing', error: null });
    await jobs.idle();
    expect(jobs.get(id)).toMatchObject({ status: 'sent', error: null });
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it('keeps a failure with its message, and Retry sends the same job again', async () => {
    const jobs = new PrintJobs();
    const results: SendResult[] = [
      { ok: false, message: 'Printer not reachable at 127.0.0.1:9100' },
      { ok: true },
    ];
    const attempt = vi.fn(async () => results.shift()!);
    const onResult = vi.fn(async () => {});
    const id = jobs.start(receipt, { attempt, onResult });
    await jobs.idle();
    expect(jobs.get(id)).toMatchObject({
      status: 'failed',
      error: 'Printer not reachable at 127.0.0.1:9100',
    });
    jobs.retry(id);
    await jobs.idle();
    expect(jobs.get(id)?.status).toBe('sent');
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls).toEqual([[false], [true]]);
  });

  it('treats an attempt that throws as a failure', async () => {
    const jobs = new PrintJobs();
    const id = jobs.start(receipt, {
      attempt: () => Promise.reject(new Error('boom')),
    });
    await jobs.idle();
    expect(jobs.get(id)).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('runs one job at a time, in order', async () => {
    const jobs = new PrintJobs();
    const first = deferred();
    const second = deferred();
    jobs.start(receipt, { attempt: first.attempt });
    jobs.start({ kind: 'drawer', title: 'Cash drawer', doc: null }, { attempt: second.attempt });
    await Promise.resolve();
    expect(first.attempt).toHaveBeenCalledTimes(1);
    expect(second.attempt).not.toHaveBeenCalled();
    first.answer({ ok: true });
    await vi.waitFor(() => expect(second.attempt).toHaveBeenCalledTimes(1));
    second.answer({ ok: true });
    await jobs.idle();
  });

  it('counts a failure as dealt with once shown on screen or dismissed', async () => {
    const jobs = new PrintJobs();
    const onSettle = vi.fn(async () => {});
    const id = jobs.start(receipt, {
      attempt: async () => ({ ok: false, message: 'Out of paper?' }),
      onSettle,
    });
    await jobs.idle();
    const unseen = () => jobs.list().filter((j) => j.status === 'failed' && !j.settled);
    expect(unseen()).toHaveLength(1);
    jobs.settle(id);
    expect(unseen()).toHaveLength(0);
    expect(onSettle).toHaveBeenCalledTimes(1);
    // Settling twice records nothing more.
    jobs.settle(id);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('knows which jobs a screen is showing', async () => {
    const jobs = new PrintJobs();
    const id = jobs.start(receipt, { attempt: async () => ({ ok: true }) });
    const stop = jobs.watch(id);
    const again = jobs.watch(id);
    expect(jobs.get(id)?.watchers).toBe(2);
    stop();
    again();
    expect(jobs.get(id)?.watchers).toBe(0);
    await jobs.idle();
  });

  it('tells listeners about every change, with a new list each time', async () => {
    const jobs = new PrintJobs();
    const seen: unknown[] = [];
    jobs.subscribe(() => seen.push(jobs.list()));
    jobs.start(receipt, { attempt: async () => ({ ok: true }) });
    await jobs.idle();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('forgets old finished jobs but never an unseen failure', async () => {
    const jobs = new PrintJobs();
    const failed = jobs.start(receipt, { attempt: async () => ({ ok: false, message: 'x' }) });
    for (let i = 0; i < 30; i++) jobs.start(receipt, { attempt: async () => ({ ok: true }) });
    await jobs.idle();
    expect(jobs.list().length).toBeLessThanOrEqual(21);
    expect(jobs.get(failed)?.status).toBe('failed');
  });
});
