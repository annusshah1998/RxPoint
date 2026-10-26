import type { IncomingMessage, ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import type { Plugin } from 'vite';

/**
 * The browser preview has no Rust side, so it can't open a TCP connection to a printer.
 * In development only, this dev-server route does what `print_raw` does in Network mode
 * (src-tauri/src/printer.rs): connect, send the bytes, close. That lets the preview and
 * the Playwright tests print to scripts/fake-printer.mjs, or to a real network printer.
 * It is not part of any build.
 */

/** Must match DEV_PRINT_PATH in src/platform/printer.ts. */
const PATH = '/__dev/print-raw';
/** Same limit as printer.rs: receipts are a few KB. */
const MAX_JOB_BYTES = 256 * 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function devPrinterBridge(): Plugin {
  return {
    name: 'dev-printer-bridge',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(PATH, (req, res) => void handle(req, res));
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') return reply(res, 405, 'POST only');
  // Only the till's own page may print: another site open in the same browser can't,
  // because it can't send these headers without the browser asking first (CORS).
  const origin = req.headers.origin;
  if (origin && !isLocal(origin)) return reply(res, 403, 'Forbidden');
  const host = String(req.headers['x-printer-host'] ?? '').trim();
  const port = Number(req.headers['x-printer-port']);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return reply(res, 400, 'Printer address missing');
  }
  const bytes = await readBody(req);
  if (bytes === null) return reply(res, 413, 'The print job is too large');
  if (bytes.length === 0) return reply(res, 400, 'Nothing to print');
  try {
    await sendRaw(host, port, bytes);
    reply(res, 204, '');
  } catch (error) {
    reply(res, 502, error instanceof Error ? error.message : String(error));
  }
}

function isLocal(origin: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function reply(res: ServerResponse, status: number, text: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_JOB_BYTES) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_JOB_BYTES ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Like printer.rs: 3 s to connect, 5 s to take the bytes, with the same messages. */
function sendRaw(host: string, port: number, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let connected = false;
    const fail = (message: string) => {
      socket.destroy();
      reject(new Error(message));
    };
    const unreachable = `Printer not reachable at ${host}:${port}`;
    const connectTimer = setTimeout(() => fail(unreachable), 3_000);
    socket.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      socket.setTimeout(5_000, () =>
        fail(`Printer at ${host}:${port} stopped accepting data (timed out)`),
      );
      socket.end(bytes, () => {
        socket.setTimeout(0);
        resolve();
      });
    });
    socket.on('error', (error) => {
      clearTimeout(connectTimer);
      fail(
        connected
          ? `Printer at ${host}:${port} stopped accepting data (${error.message})`
          : unreachable,
      );
    });
  });
}
