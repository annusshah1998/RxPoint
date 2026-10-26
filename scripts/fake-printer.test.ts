import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeEscPos, startFakePrinter, type FakePrinter } from './fake-printer.mjs';

const bytes = (...parts: (number[] | string)[]) =>
  Uint8Array.from(
    parts.flatMap((p) => (typeof p === 'string' ? Array.from(p, (c) => c.charCodeAt(0)) : p)),
  );

describe('describeEscPos', () => {
  it('shows the text as printed and the commands in brackets', () => {
    const job = bytes(
      [0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa, 0x1b, 0x74, 0x00, 0x1b, 0x61, 0x00],
      [0x1b, 0x45, 0x01, 0x1d, 0x21, 0x11],
      'SHIFA',
      [0x0a, 0x1d, 0x21, 0x00, 0x1b, 0x45, 0x00],
      'Invoice T1-000001',
      [0x0a],
      [0x1b, 0x61, 0x01, 0x1d, 0x68, 60, 0x1d, 0x77, 2, 0x1d, 0x48, 0],
      [0x1d, 0x6b, 0x49, 11, 0x7b, 0x42],
      'T1-000001',
      [0x0a, 0x1b, 0x61, 0x00],
      [0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00],
    );
    expect(describeEscPos(job)).toEqual([
      '[init]',
      '[drawer pin 2 (50 ms on, 500 ms off)]',
      '[code page 437]',
      '[align left]',
      '[bold]',
      '[large]',
      'SHIFA',
      '[/large]',
      '[/bold]',
      'Invoice T1-000001',
      '[align center]',
      '[barcode height 60]',
      '[barcode width 2]',
      '[barcode text 0]',
      '[barcode CODE128 T1-000001]',
      '[align left]',
      '[feed 4]',
      '--- cut ---',
    ]);
  });

  it('tells pin 5 from pin 2, and shows unknown bytes as hex', () => {
    expect(describeEscPos(bytes([0x1b, 0x40, 0x1b, 0x70, 0x01, 0x19, 0xfa]))).toEqual([
      '[init]',
      '[drawer pin 5 (50 ms on, 500 ms off)]',
    ]);
    expect(describeEscPos(bytes('a', [0x07], 'b', [0x0a]))).toEqual(['a[07]b']);
  });
});

describe('startFakePrinter', () => {
  let printer: FakePrinter | null = null;
  let dir: string | null = null;
  afterEach(async () => {
    await printer?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    printer = null;
    dir = null;
  });

  it('saves each connection as a job, with a readable dump', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fake-printer-test-'));
    printer = await startFakePrinter({ port: 0, outDir: dir, quiet: true });
    const send = (data: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        const socket = connect(printer!.port, '127.0.0.1', () => socket.end(data));
        socket.on('close', () => resolve());
        socket.on('error', reject);
      });
    await send(bytes([0x1b, 0x40], 'hello', [0x0a]));
    await send(bytes([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]));
    const jobs = await printer.waitForJobs(2);
    expect(jobs.map((j) => j.n)).toEqual([1, 2]);
    expect(jobs[0]!.lines).toEqual(['[init]', 'hello']);
    expect(readFileSync(join(dir, 'job-2.bin'))).toEqual(
      Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]),
    );
    expect(readFileSync(join(dir, 'job-2.txt'), 'utf8')).toContain('[drawer pin 2');
  });

  it('carries on numbering after jobs already in the folder', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fake-printer-test-'));
    printer = await startFakePrinter({ port: 0, outDir: dir, quiet: true });
    const sock = connect(printer.port, '127.0.0.1', () => sock.end(Buffer.from('x\n')));
    await printer.waitForJobs(1);
    await printer.close();
    printer = await startFakePrinter({ port: 0, outDir: dir, quiet: true });
    const again = connect(printer.port, '127.0.0.1', () => again.end(Buffer.from('y\n')));
    const [job] = await printer.waitForJobs(1);
    expect(job!.n).toBe(2);
  });

  it('gives up waiting with a clear message', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fake-printer-test-'));
    printer = await startFakePrinter({ port: 0, outDir: dir, quiet: true });
    await expect(printer.waitForJobs(1, 50)).rejects.toThrow('Expected 1 print jobs, got 0');
  });
});
