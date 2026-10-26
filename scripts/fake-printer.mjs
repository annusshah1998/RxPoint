#!/usr/bin/env node
/**
 * A pretend network receipt printer, for testing printing and the cash drawer with no
 * hardware (docs/m2-design.md §6.4).
 *
 * It listens like an 80 mm thermal printer on raw TCP (port 9100): every connection is one
 * job. Each job is saved as job-N.bin (the exact bytes) and job-N.txt (a readable dump:
 * the text as it would print, with the commands in brackets, e.g. [bold], [drawer pin 2]
 * and --- cut ---). The dump is also shown in the terminal.
 *
 *   pnpm printer:fake                      # 127.0.0.1:9100, jobs in the temp folder
 *   node scripts/fake-printer.mjs --port 9101 --out ./jobs
 *
 * Then set Settings → This till's printer to Network, IP 127.0.0.1, port 9100. The browser
 * preview (pnpm dev) prints through the dev server; the desktop app prints directly.
 * The Playwright tests start their own copy on a free port (startFakePrinter).
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** The byte as two hex digits, e.g. "1B". */
const hex = (b) => (b ?? 0).toString(16).toUpperCase().padStart(2, '0');

/**
 * ESC/POS bytes as readable lines: printed text as is, commands in brackets. Covers what
 * packages/receipt sends; anything else shows as hex so nothing is hidden.
 */
export function describeEscPos(bytes) {
  const out = [];
  let text = '';
  const flush = () => {
    if (text) out.push(text);
    text = '';
  };
  const cmd = (label) => {
    flush();
    out.push(`[${label}]`);
  };
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b === ESC) {
      const c = bytes[i + 1];
      const n = bytes[i + 2];
      if (c === 0x40) {
        cmd('init');
        i += 2;
      } else if (c === 0x70) {
        // ESC p m t1 t2: m 0 or '0' is pin 2, m 1 or '1' is pin 5.
        cmd(
          `drawer pin ${n % 2 === 0 ? 2 : 5} (${bytes[i + 3] * 2} ms on, ${bytes[i + 4] * 2} ms off)`,
        );
        i += 5;
      } else if (c === 0x74) {
        cmd(`code page ${n === 0 ? '437' : n}`);
        i += 3;
      } else if (c === 0x61) {
        cmd(`align ${['left', 'center', 'right'][n % 48] ?? n}`);
        i += 3;
      } else if (c === 0x45) {
        cmd(n % 2 ? 'bold' : '/bold');
        i += 3;
      } else if (c === 0x64) {
        cmd(`feed ${n}`);
        i += 3;
      } else {
        cmd(`ESC ${hex(c)}`);
        i += 2;
      }
      continue;
    }
    if (b === GS) {
      const c = bytes[i + 1];
      const n = bytes[i + 2];
      if (c === 0x21) {
        cmd(n === 0 ? '/large' : n === 0x11 ? 'large' : `size ${hex(n)}`);
        i += 3;
      } else if (c === 0x56) {
        flush();
        out.push('--- cut ---');
        // GS V 65/66 n (feed, then cut) has one more byte than GS V 0/1/48/49.
        i += n === 0x41 || n === 0x42 ? 4 : 3;
      } else if (c === 0x68 || c === 0x77 || c === 0x48) {
        const what = { 0x68: 'height', 0x77: 'width', 0x48: 'text' }[c];
        cmd(`barcode ${what} ${n}`);
        i += 3;
      } else if (c === 0x6b) {
        const m = n;
        if (m >= 65) {
          const len = bytes[i + 3];
          let data = String.fromCharCode(...bytes.slice(i + 4, i + 4 + len));
          // CODE128 data starts with the code set, e.g. "{B".
          if (m === 73 && data.startsWith('{')) data = data.slice(2);
          cmd(`barcode ${m === 73 ? 'CODE128' : `type ${m}`} ${data}`);
          i += 4 + len;
          // The line feed after a barcode only moves past it; it isn't a line of text.
          if (bytes[i] === LF) i += 1;
        } else {
          let end = i + 3;
          while (end < bytes.length && bytes[end] !== 0) end += 1;
          cmd(`barcode type ${m} ${String.fromCharCode(...bytes.slice(i + 3, end))}`);
          i = end + 1;
        }
      } else {
        cmd(`GS ${hex(c)}`);
        i += 2;
      }
      continue;
    }
    if (b === LF) {
      out.push(text);
      text = '';
      i += 1;
      continue;
    }
    text += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `[${hex(b)}]`;
    i += 1;
  }
  flush();
  return out;
}

/**
 * Starts a fake printer. `port: 0` picks a free port (the tests do). Resolves once it is
 * listening; `close()` stops it.
 */
export function startFakePrinter({
  host = '127.0.0.1',
  port = 9100,
  outDir = join(tmpdir(), 'fake-printer-jobs'),
  quiet = false,
} = {}) {
  mkdirSync(outDir, { recursive: true });
  // Carry on numbering after jobs already in the folder, so nothing is overwritten.
  let next =
    Math.max(0, ...readdirSync(outDir).map((f) => Number(/^job-(\d+)\.bin$/.exec(f)?.[1] ?? 0))) +
    1;
  const jobs = [];
  const waiters = new Set();
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (bytes.length === 0) return;
      const n = next++;
      const lines = describeEscPos(bytes);
      const file = join(outDir, `job-${n}.bin`);
      writeFileSync(file, bytes);
      writeFileSync(join(outDir, `job-${n}.txt`), `${lines.join('\n')}\n`);
      jobs.push({ n, bytes, lines, file });
      if (!quiet) {
        console.log(`\n=== job ${n}: ${bytes.length} bytes → ${file}`);
        console.log(lines.join('\n'));
      }
      for (const w of waiters) w();
    });
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once('error', rejectStart);
    server.listen(port, host, () => {
      server.off('error', rejectStart);
      const address = server.address();
      resolveStart({
        host,
        port: typeof address === 'object' && address ? address.port : port,
        outDir,
        jobs,
        /** Resolves when at least `count` jobs have arrived in total. */
        waitForJobs(count, timeoutMs = 10_000) {
          return new Promise((done, fail) => {
            const check = () => {
              if (jobs.length < count) return;
              clearTimeout(timer);
              waiters.delete(check);
              done(jobs.slice());
            };
            const timer = setTimeout(() => {
              waiters.delete(check);
              fail(new Error(`Expected ${count} print jobs, got ${jobs.length}`));
            }, timeoutMs);
            waiters.add(check);
            check();
          });
        },
        close() {
          for (const s of sockets) s.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const printer = await startFakePrinter({
    host: argValue('--host') ?? '127.0.0.1',
    port: Number(argValue('--port') ?? 9100),
    outDir: argValue('--out') ? resolve(argValue('--out')) : undefined,
  });
  console.log(`Fake receipt printer listening on ${printer.host}:${printer.port}`);
  console.log(`Saving jobs in ${printer.outDir}`);
  console.log('Ctrl+C to stop.');
}
