import { initial } from './0001-initial';
import { checkout } from './0002-checkout';
import type { Migration } from './types';

/**
 * All migrations, oldest first. Never edit a migration that has shipped to a
 * pharmacy; add a new one instead.
 */
export const MIGRATIONS: readonly Migration[] = [initial, checkout];

export type { Migration };
