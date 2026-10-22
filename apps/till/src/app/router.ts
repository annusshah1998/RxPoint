import { useCallback, useSyncExternalStore } from 'react';

/** Screens. The URL hash mirrors the route so reloads and the back key work. */
export type Route =
  | { name: 'sale' }
  | { name: 'sales' }
  | { name: 'products' }
  | { name: 'product-new' }
  | { name: 'product'; id: string }
  | { name: 'product-edit'; id: string }
  | { name: 'stock' }
  | { name: 'import' }
  | { name: 'staff' }
  | { name: 'shift' }
  | { name: 'backups' }
  | { name: 'settings' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [section, id, action] = parts;
  if (section === 'sales') return { name: 'sales' };
  if (section === 'products') {
    if (id === 'new') return { name: 'product-new' };
    if (id && action === 'edit') return { name: 'product-edit', id };
    if (id) return { name: 'product', id };
    return { name: 'products' };
  }
  if (section === 'stock') return { name: 'stock' };
  if (section === 'import') return { name: 'import' };
  if (section === 'staff') return { name: 'staff' };
  if (section === 'shift') return { name: 'shift' };
  if (section === 'backups') return { name: 'backups' };
  if (section === 'settings') return { name: 'settings' };
  return { name: 'sale' };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'sale':
      return '#/sale';
    case 'sales':
      return '#/sales';
    case 'products':
      return '#/products';
    case 'product-new':
      return '#/products/new';
    case 'product':
      return `#/products/${encodeURIComponent(route.id)}`;
    case 'product-edit':
      return `#/products/${encodeURIComponent(route.id)}/edit`;
    case 'stock':
      return '#/stock';
    case 'import':
      return '#/import';
    case 'staff':
      return '#/staff';
    case 'shift':
      return '#/shift';
    case 'backups':
      return '#/backups';
    case 'settings':
      return '#/settings';
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const navigate = useCallback((route: Route, options: { replace?: boolean } = {}) => {
    const target = routeHash(route);
    if (options.replace) {
      window.history.replaceState(null, '', target);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = target;
    }
  }, []);
  const back = useCallback(() => window.history.back(), []);
  return { route: parseHash(hash), navigate, back };
}
