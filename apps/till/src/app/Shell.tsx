import { PRODUCT } from '@app/config';
import { ROLE_LABELS, can, type Permission } from '@app/core';
import { getStoreSettings } from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ImportScreen } from '../features/import/ImportScreen';
import { ProductDetailScreen } from '../features/products/ProductDetailScreen';
import { ProductEditScreen } from '../features/products/ProductEditScreen';
import { ProductsScreen } from '../features/products/ProductsScreen';
import { SaleScreen } from '../features/sale/SaleScreen';
import { SalesScreen } from '../features/sales/SalesScreen';
import { BackupBadges } from '../features/backups/BackupBadges';
import { BackupsScreen } from '../features/backups/BackupsScreen';
import { useBackupSchedule } from '../features/backups/use-backup-schedule';
import { ClockBanner, ClockBlockScreen, useClockStatus } from '../features/clock/ClockGuard';
import { PrintProblems, ReceiptNotice } from '../features/printing/PrintStatus';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { ShiftScreen } from '../features/shift/ShiftScreen';
import { StaffScreen } from '../features/staff/StaffScreen';
import { StockScreen } from '../features/stock/StockScreen';
import { S } from '../strings';
import { Button } from '../ui';
import { HelpDialog } from './HelpDialog';
import { dialogOpen, keyDigit, onlyMods } from './keys';
import { routeHash, useRoute, type Route } from './router';
import { useServices } from './services';

interface NavItem {
  label: string;
  route: Route;
  matches: Route['name'][];
  needs?: Permission;
  /** Alt+this digit opens the screen (§5.4). */
  key?: string;
}

const NAV: NavItem[] = [
  { label: S.nav.sale, route: { name: 'sale' }, matches: ['sale'], needs: 'sale.sell', key: '1' },
  {
    label: S.nav.sales,
    route: { name: 'sales' },
    matches: ['sales'],
    needs: 'sale.reprint',
    key: '2',
  },
  {
    label: S.nav.shift,
    route: { name: 'shift' },
    matches: ['shift'],
    needs: 'shift.open',
    key: '5',
  },
  {
    label: S.nav.products,
    route: { name: 'products' },
    matches: ['products', 'product', 'product-new', 'product-edit'],
    key: '3',
  },
  { label: S.nav.stock, route: { name: 'stock' }, matches: ['stock'], key: '4' },
  { label: S.nav.import, route: { name: 'import' }, matches: ['import'], needs: 'import.run' },
  { label: S.nav.backups, route: { name: 'backups' }, matches: ['backups'], needs: 'backup.run' },
  { label: S.nav.staff, route: { name: 'staff' }, matches: ['staff'], needs: 'users.manage' },
  {
    label: S.nav.settings,
    route: { name: 'settings' },
    matches: ['settings'],
    needs: 'settings.edit',
    key: '9',
  },
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
  useBackupSchedule();
  const clock = useClockStatus();
  const [help, setHelp] = useState(false);
  const nav = NAV.filter((item) => !item.needs || can(store.userRole, item.needs));

  // Keys that work on every screen: Ctrl+L, F1 and Alt+digit for the screens this person
  // may open. A screen key waits while a dialog is open, so a half-done form isn't lost.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        void lock();
      } else if (e.key === 'F1' && onlyMods(e, {})) {
        e.preventDefault();
        setHelp((open) => !open);
      } else if (onlyMods(e, { alt: true })) {
        const digit = keyDigit(e);
        const item = digit ? NAV.find((n) => n.key === digit) : undefined;
        if (!item) return;
        e.preventDefault();
        if (dialogOpen()) return;
        if (item.needs && !can(store.userRole, item.needs)) return;
        navigate(item.route);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [lock, navigate, store.userRole]);

  // A date that can't be right stops everything until Windows is fixed (§4.8).
  if (clock.data?.blocks) {
    return <ClockBlockScreen status={clock.data} onCheck={() => void clock.refetch()} />;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">{PRODUCT.name}</div>
        <div className="store-name">{store.branchName}</div>
        <nav aria-label="Main">
          {nav.map((item) => (
            <a
              key={item.label}
              href={routeHash(item.route)}
              className={`nav-link ${item.matches.includes(route.name) ? 'active' : ''}`}
              aria-current={item.matches.includes(route.name) ? 'page' : undefined}
              aria-keyshortcuts={item.key ? S.nav.key(item.key) : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(item.route);
              }}
            >
              {item.label}
              {item.key && (
                <kbd className="nav-key" aria-hidden="true">
                  {S.nav.key(item.key)}
                </kbd>
              )}
            </a>
          ))}
        </nav>
        <BackupBadges canOpen={can(store.userRole, 'backup.run')} />
        <div className="sidebar-footer">
          <div>
            {S.nav.till} {store.tillCode} · {store.userName}
            <div className="muted">{ROLE_LABELS[store.userRole]}</div>
          </div>
          <div className="sidebar-buttons">
            <Button
              size="small"
              variant="ghost"
              onClick={() => setHelp(true)}
              aria-keyshortcuts={S.help.key}
            >
              {S.help.button} <kbd>{S.help.key}</kbd>
            </Button>
            <Button
              size="small"
              variant="ghost"
              onClick={() => void lock()}
              title={S.auth.lockHint}
            >
              {S.auth.lock}
            </Button>
          </div>
        </div>
      </aside>
      <main className="main">
        {platform === 'browser' && <PreviewBanner />}
        {clock.data && <ClockBanner status={clock.data} />}
        <ReceiptNotice />
        <PrintProblems />
        <Screen route={route} canSell={can(store.userRole, 'sale.sell')} />
      </main>
      {help && (
        <HelpDialog
          screens={nav.flatMap((n) => (n.key ? [{ key: n.key, label: n.label }] : []))}
          onClose={() => setHelp(false)}
        />
      )}
    </div>
  );
}

function Screen({ route, canSell }: { route: Route; canSell: boolean }) {
  switch (route.name) {
    case 'sale':
      // The home screen; staff who don't sell (inventory) start on Products.
      return canSell ? <SaleScreen /> : <ProductsScreen />;
    case 'sales':
      return <SalesScreen />;
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
    case 'backups':
      return <BackupsScreen />;
    case 'settings':
      return <SettingsScreen />;
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
