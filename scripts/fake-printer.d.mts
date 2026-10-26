/** Types for fake-printer.mjs (used by the Playwright tests and unit tests). */

export interface FakePrintJob {
  /** The N in job-N.bin. */
  n: number;
  bytes: Uint8Array;
  /** The readable dump: printed text as is, commands in brackets. */
  lines: string[];
  /** Where job-N.bin was saved. */
  file: string;
}

export interface FakePrinter {
  host: string;
  port: number;
  outDir: string;
  jobs: FakePrintJob[];
  waitForJobs(count: number, timeoutMs?: number): Promise<FakePrintJob[]>;
  close(): Promise<void>;
}

export function describeEscPos(bytes: Uint8Array): string[];

export function startFakePrinter(options?: {
  host?: string;
  port?: number;
  outDir?: string;
  quiet?: boolean;
}): Promise<FakePrinter>;
