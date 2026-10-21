import { PRODUCT } from '@app/config';
import {
  createServiceContext,
  getStoreInfo,
  loadSession,
  openDatabase,
  withSession,
  type ServiceContext,
} from '@app/db';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { SetupScreen } from '../features/setup/SetupScreen';
import { errorMessage } from '../lib/errors';
import { createExecutor, currentPlatform, type Platform } from '../platform';
import { S } from '../strings';
import { Notice } from '../ui';
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
  | { status: 'setup'; ctx: ServiceContext; platform: Platform }
  | { status: 'ready'; services: Services };

// Opened once per page load, even if React mounts this component twice in development.
let started: Promise<BootState> | null = null;

async function start(): Promise<BootState> {
  const platform = currentPlatform();
  const db = await openDatabase(await createExecutor());
  const ctx = createServiceContext(db);
  const session = await loadSession(ctx);
  if (!session) return { status: 'setup', ctx, platform };
  const app = withSession(ctx, session);
  return { status: 'ready', services: { ctx: app, store: await getStoreInfo(app), platform } };
}

export function Boot() {
  const [state, setState] = useState<BootState>({ status: 'starting' });

  useEffect(() => {
    started ??= start();
    started.then(setState, (error: unknown) => {
      console.error(error);
      setState({
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

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
          ctx={state.ctx}
          onDone={async (session) => {
            try {
              const app = withSession(state.ctx, session);
              const store = await getStoreInfo(app);
              setState({
                status: 'ready',
                services: { ctx: app, store, platform: state.platform },
              });
            } catch (error) {
              setState({ status: 'failed', message: errorMessage(error) });
            }
          }}
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
