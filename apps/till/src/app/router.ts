import { useCallback, useSyncExternalStore } from 'react';

/** Screens. The URL hash mirrors the route so reloads and the back key work. */
export type Route =
  | { name: 'products' }
  | { name: 'product-new' }
  | { name: 'product'; id: string }
  | { name: 'product-edit'; id: string }
  | { name: 'stock' }
  | { name: 'import' }
  | { name: 'staff' };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [section, id, action] = parts;
  if (section === 'stock') return { name: 'stock' };
  if (section === 'import') return { name: 'import' };
  if (section === 'staff') return { name: 'staff' };
  if (section === 'products' && id === 'new') return { name: 'product-new' };
  if (section === 'products' && id && action === 'edit') return { name: 'product-edit', id };
  if (section === 'products' && id) return { name: 'product', id };
  return { name: 'products' };
}

export function routeHash(route: Route): string {
  switch (route.name) {
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
