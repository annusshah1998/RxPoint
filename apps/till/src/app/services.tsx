import type { AppContext, StoreInfo } from '@app/db';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import type { Platform } from '../platform';

export interface Services {
  ctx: AppContext;
  store: StoreInfo;
  platform: Platform;
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ value, children }: { value: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices outside ServicesProvider');
  return services;
}

/**
 * Runs a write against the local database. On success every cached query is
 * refreshed: the database is local and fast, so precise invalidation isn't worth it.
 */
export function useAction<TInput, TResult>(
  action: (ctx: AppContext, input: TInput) => Promise<TResult>,
  options: { onSuccess?: (result: TResult, input: TInput) => void } = {},
) {
  const { ctx } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => action(ctx, input),
    onSuccess: async (result, input) => {
      await queryClient.invalidateQueries();
      options.onSuccess?.(result, input);
    },
  });
}
