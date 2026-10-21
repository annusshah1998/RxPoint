import { describe, expect, it } from 'vitest';
import { parseHash, routeHash, type Route } from './router';

describe('router', () => {
  it.each<Route>([
    { name: 'products' },
    { name: 'product-new' },
    { name: 'product', id: '0192b6c0-0000-7000-8000-000000000000' },
    { name: 'product-edit', id: 'abc' },
    { name: 'stock' },
    { name: 'import' },
  ])('round-trips %j', (route) => {
    expect(parseHash(routeHash(route))).toEqual(route);
  });

  it('falls back to products for unknown hashes', () => {
    expect(parseHash('')).toEqual({ name: 'products' });
    expect(parseHash('#/nowhere')).toEqual({ name: 'products' });
  });
});
