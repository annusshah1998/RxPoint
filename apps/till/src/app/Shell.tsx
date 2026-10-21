import { PRODUCT } from '@app/config';
import { ROLE_LABELS, can, type Permission } from '@app/core';
import { getStoreSettings } from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ImportScreen } from '../features/import/ImportScreen';
import { ProductDetailScreen } from '../features/products/ProductDetailScreen';
import { ProductEditScreen } from '../features/products/ProductEditScreen';
import { ProductsScreen } from '../features/products/ProductsScreen';
import { ShiftScreen } from '../features/shift/ShiftScreen';
import { StaffScreen } from '../features/staff/StaffScreen';
import { StockScreen } from '../features/stock/StockScreen';
import { S } from '../strings';
import { Button } from '../ui';
import { routeHash, useRoute, type Route } from './router';
import { useServices } from './services';

const NAV: { label: string; route: Route; matches: Route['name'][]; needs?: Permission }[] = [
  { label: S.nav.shift, route: { name: 'shift' }, matches: ['shift'], needs: 'shift.open' },
  {
    label: S.nav.products,
    route: { name: 'products' },
    matches: ['products', 'product', 'product-new', 'product-edit'],
  },
  { label: S.nav.stock, route: { name: 'stock' }, matches: ['stock'] },
  { label: S.nav.import, route: { name: 'import' }, matches: ['import'], needs: 'import.run' },
  { label: S.nav.staff, route: { name: 'staff' }, matches: ['staff'], needs: 'users.manage' },
];

/** Locks the till after `minutes` without a key press, click or touch. */
function useIdleLock(minutes: number | undefined, lock: () => Promise<void>) {
  useEffect(() => {
    if (!minutes) return;
    let timer = window.setTimeout(() => void lock(), minutes * 60_000);
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void lock(), minutes * 60_000);
    };
    const events = ['keydown', 'pointerdown', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, reset, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, reset, { capture: true });
    };
  }, [minutes, lock]);
}

export function Shell() {
  const { ctx, store, platform, lock } = useServices();
  const { route, navigate } = useRoute();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => getStoreSettings(ctx) });
  useIdleLock(settings.data?.autoLockMinutes, lock);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        void lock();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [lock]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">{PRODUCT.name}</div>
        <div className="store-name">{store.branchName}</div>
        <nav aria-label="Main">
          {NAV.filter((item) => !item.needs || can(store.userRole, item.needs)).map((item) => (
            <a
              key={item.label}
              href={routeHash(item.route)}
              className={`nav-link ${item.matches.includes(route.name) ? 'active' : ''}`}
              aria-current={item.matches.includes(route.name) ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.route);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div>
            {S.nav.till} {store.tillCode} · {store.userName}
            <div className="muted">{ROLE_LABELS[store.userRole]}</div>
          </div>
          <Button size="small" variant="ghost" onClick={() => void lock()} title={S.auth.lockHint}>
            {S.auth.lock}
          </Button>
        </div>
      </aside>
      <main className="main">
        {platform === 'browser' && <PreviewBanner />}
        <Screen route={route} />
      </main>
    </div>
  );
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case 'products':
      return <ProductsScreen />;
    case 'product-new':
      return <ProductEditScreen key="new" />;
    case 'product-edit':
      return <ProductEditScreen key={route.id} productId={route.id} />;
    case 'product':
      return <ProductDetailScreen key={route.id} productId={route.id} />;
    case 'stock':
      return <StockScreen />;
    case 'import':
      return <ImportScreen />;
    case 'staff':
      return <StaffScreen />;
    case 'shift':
      return <ShiftScreen />;
  }
}

function PreviewBanner() {
  return (
    <div className="preview-banner">
      {S.boot.browserPreview}
      <Button
        size="small"
        variant="ghost"
        onClick={async () => {
          if (!window.confirm(S.boot.resetConfirm)) return;
          const { clearBrowserData } = await import('../platform/browser-executor');
          await clearBrowserData();
          window.location.hash = '';
          window.location.reload();
        }}
      >
        {S.boot.resetPreview}
      </Button>
    </div>
  );
}
