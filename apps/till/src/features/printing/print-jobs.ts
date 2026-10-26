import type { ReceiptDocument } from '@app/receipt';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SendResult } from '../../platform/printer';

export type JobKind = 'receipt' | 'drawer' | 'test';
export type JobStatus = 'printing' | 'sent' | 'failed';

export interface PrintJob {
  id: number;
  kind: JobKind;
  /** "Receipt T1-000123", "Cash drawer", "Test page". */
  title: string;
  status: JobStatus;
  error: string | null;
  /** What the job prints, for Show on screen (null for the drawer). */
  doc: ReceiptDocument | null;
  /** Someone has dealt with the failure (Show on screen, Skip or Dismiss). */
  settled: boolean;
  /** Screens showing this job's status. The problems bar shows only jobs no screen shows. */
  watchers: number;
}

interface Hooks {
  /** Sends the job; called again on Retry. */
  attempt: () => Promise<SendResult>;
  /** After each attempt, e.g. to record the receipt as printed or failed. */
  onResult?: (ok: boolean) => Promise<void>;
  /** When staff deal with a failure without printing. */
  onSettle?: () => Promise<void>;
}

/** Keeps this many finished jobs; failures nobody has dealt with are always kept. */
const KEEP = 20;

/**
 * Print jobs of this till, run one at a time (a thermal printer takes one connection at
 * a time). Jobs run after the document's transaction, so nothing here can undo a sale; a
 * failure stays listed until someone retries it, shows it on screen or dismisses it.
 */
export class PrintJobs {
  private jobs: readonly PrintJob[] = [];
  private hooks = new Map<number, Hooks>();
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The current jobs, oldest first. The same array until something changes. */
  list = (): readonly PrintJob[] => this.jobs;

  get(id: number): PrintJob | undefined {
    return this.jobs.find((j) => j.id === id);
  }

  /** Adds a job and starts it. Returns its id at once; the job runs in the background. */
  start(job: { kind: JobKind; title: string; doc: ReceiptDocument | null }, hooks: Hooks): number {
    const id = this.nextId++;
    this.hooks.set(id, hooks);
    this.set([
      ...this.jobs,
      { ...job, id, status: 'printing', error: null, settled: false, watchers: 0 },
    ]);
    this.run(id);
    return id;
  }

  /** Sends a failed job again, exactly as before. */
  retry(id: number): void {
    const job = this.get(id);
    if (!job || job.status !== 'failed') return;
    this.update(id, { status: 'printing', error: null, settled: false });
    this.run(id);
  }

  /** Staff have dealt with a failed job without printing it. */
  settle(id: number): void {
    const job = this.get(id);
    if (!job || job.settled) return;
    this.update(id, { settled: true });
    if (job.status === 'failed') void this.hooks.get(id)?.onSettle?.().catch(console.error);
  }

  /** A screen shows this job's status from now until the returned function is called. */
  watch(id: number): () => void {
    this.change(id, 1);
    return () => this.change(id, -1);
  }

  /** Resolves when every job started so far has had its answer (for tests). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private change(id: number, by: number) {
    const job = this.get(id);
    if (job) this.update(id, { watchers: Math.max(0, job.watchers + by) });
  }

  private run(id: number) {
    this.queue = this.queue.then(async () => {
      const hooks = this.hooks.get(id);
      if (!hooks) return;
      let result: SendResult;
      try {
        result = await hooks.attempt();
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      // Recorded first, so what the screen says is already saved.
      await hooks.onResult?.(result.ok).catch(console.error);
      this.update(
        id,
        result.ok ? { status: 'sent', error: null } : { status: 'failed', error: result.message },
      );
    });
  }

  private update(id: number, patch: Partial<PrintJob>) {
    this.set(this.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }

  private set(jobs: PrintJob[]) {
    // Forget old finished jobs, keeping failures nobody has dealt with.
    const done = (j: PrintJob) => j.status !== 'printing' && (j.status === 'sent' || j.settled);
    let extra = jobs.filter(done).length - KEEP;
    const kept = jobs.filter((j) => {
      if (extra > 0 && done(j) && j.watchers === 0) {
        extra -= 1;
        this.hooks.delete(j.id);
        return false;
      }
      return true;
    });
    this.jobs = kept;
    for (const listener of this.listeners) listener();
  }
}

/** This till's print jobs (one printer per till). */
export const printJobs = new PrintJobs();

/** One job, kept up to date; the screen counts as showing it while mounted. */
export function usePrintJob(id: number | null): PrintJob | undefined {
  const jobs = useSyncExternalStore(printJobs.subscribe, printJobs.list);
  useEffect(() => (id === null ? undefined : printJobs.watch(id)), [id]);
  return useMemo(() => (id === null ? undefined : jobs.find((j) => j.id === id)), [jobs, id]);
}

/** Failed jobs that no screen is showing and nobody has dealt with. */
export function useUnseenFailures(): PrintJob[] {
  const jobs = useSyncExternalStore(printJobs.subscribe, printJobs.list);
  return useMemo(
    () => jobs.filter((j) => j.status === 'failed' && !j.settled && j.watchers === 0),
    [jobs],
  );
}
