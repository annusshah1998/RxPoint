import { PRODUCT } from '@app/config';
import {
  createServiceContext,
  getStoreInfo,
  getStoreName,
  loadDevice,
  logout,
  openDatabase,
  ownerNeedsPin,
  withSession,
  type BackupPort,
  type ServiceContext,
  type Session,
} from '@app/db';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { LoginScreen } from '../features/auth/LoginScreen';
import { OwnerPinScreen } from '../features/auth/OwnerPinScreen';
import { RecoveryCodeScreen } from '../features/auth/RecoveryCodeScreen';
import { SetupScreen } from '../features/setup/SetupScreen';
import { errorMessage } from '../lib/errors';
import { createBackupPort, createExecutor, currentPlatform, type Platform } from '../platform';
import { createPrinterPort, type PrinterPort } from '../platform/printer';
import { S } from '../strings';
import { Notice } from '../ui';
import { useBrowserKeyGuard } from './keys';
import { ServicesProvider, type Services } from './services';
import { Shell } from './Shell';

const queryClient = new QueryClient({
  defaultOptions: {
    // Data is local: no need to refetch on focus or retry.
    queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity },
    mutations: { retry: false },
  },
});

type BootState =
  | { status: 'starting' }
  | { status: 'failed'; message: string }
  | { status: 'setup' }
  | { status: 'owner-pin' }
  | { status: 'login'; storeName: string }
  /** Shown once after setup or a PIN reset; `session` continues straight in after setup. */
  | { status: 'recovery-code'; code: string; session: Session | null }
  | { status: 'ready'; services: Services };

interface Opened {
  ctx: ServiceContext;
  platform: Platform;
  backupPort: BackupPort | null;
  printer: PrinterPort;
}

// Opened once per page load, even if React mounts this component twice in development.
let opened: Promise<Opened> | null = null;

async function open(): Promise<Opened> {
  const platform = currentPlatform();
  const db = await openDatabase(await createExecutor());
  return {
    ctx: createServiceContext(db, { buildTime: new Date(__BUILD_TIME__) }),
    platform,
    backupPort: await createBackupPort(platform),
    printer: createPrinterPort(platform),
  };
}

/** Which screen a till starts on: setup, the owner's first PIN, or login. */
async function firstScreen(ctx: ServiceContext): Promise<BootState> {
  if (!(await loadDevice(ctx))) return { status: 'setup' };
  if (await ownerNeedsPin(ctx)) return { status: 'owner-pin' };
  return { status: 'login', storeName: await getStoreName(ctx) };
}

export function Boot() {
  const [state, setState] = useState<BootState>({ status: 'starting' });
  const [base, setBase] = useState<Opened | null>(null);
  useBrowserKeyGuard();

  const fail = useCallback((error: unknown) => {
    console.error(error);
    setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
  }, []);

  useEffect(() => {
    opened ??= open();
    opened.then(async (o) => {
      setBase(o);
      setState(await firstScreen(o.ctx));
    }, fail);
  }, [fail]);

  const enter = useCallback(
    async (session: Session) => {
      if (!base) return;
      try {
        const app = withSession(base.ctx, session);
        const store = await getStoreInfo(app);
        queryClient.clear();
        // Each login starts on the home screen, not wherever the last person left off.
        window.history.replaceState(null, '', '#/');
        const lock = async () => {
          await logout(app).catch(console.error);
          queryClient.clear();
          setState(await firstScreen(base.ctx));
        };
        setState({
          status: 'ready',
          services: {
            ctx: app,
            store,
            platform: base.platform,
            lock,
            backupPort: base.backupPort,
            printer: base.printer,
          },
        });
      } catch (error) {
        setState({ status: 'failed', message: errorMessage(error) });
      }
    },
    [base],
  );

  switch (state.status) {
    case 'starting':
      return <div className="boot">{S.boot.starting}</div>;
    case 'failed':
      return (
        <div className="boot">
          <h1>{PRODUCT.name}</h1>
          <Notice tone="bad">
            {S.boot.failed}: {state.message}
          </Notice>
        </div>
      );
    case 'setup':
      return (
        <SetupScreen
          ctx={base!.ctx}
          onDone={({ session, recoveryCode }) =>
            setState({ status: 'recovery-code', code: recoveryCode, session })
          }
        />
      );
    case 'owner-pin':
      return (
        <OwnerPinScreen
          ctx={base!.ctx}
          onDone={({ session, recoveryCode }) =>
            setState({ status: 'recovery-code', code: recoveryCode, session })
          }
        />
      );
    case 'recovery-code':
      return (
        <RecoveryCodeScreen
          code={state.code}
          onDone={() => {
            if (state.session) void enter(state.session);
            else void firstScreen(base!.ctx).then(setState, fail);
          }}
        />
      );
    case 'login':
      return (
        <LoginScreen
          ctx={base!.ctx}
          storeName={state.storeName}
          onLogin={(session) => void enter(session)}
          onRecovered={(code) => setState({ status: 'recovery-code', code, session: null })}
        />
      );
    case 'ready':
      return (
        <QueryClientProvider client={queryClient}>
          <ServicesProvider value={state.services}>
            <Shell />
          </ServicesProvider>
        </QueryClientProvider>
      );
  }
}
