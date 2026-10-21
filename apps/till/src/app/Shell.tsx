import { PRODUCT } from '@app/config';
import { ImportScreen } from '../features/import/ImportScreen';
import { ProductDetailScreen } from '../features/products/ProductDetailScreen';
import { ProductEditScreen } from '../features/products/ProductEditScreen';
import { ProductsScreen } from '../features/products/ProductsScreen';
import { StockScreen } from '../features/stock/StockScreen';
import { S } from '../strings';
import { Button } from '../ui';
import { routeHash, useRoute, type Route } from './router';
import { useServices } from './services';

const NAV: { label: string; route: Route; matches: Route['name'][] }[] = [
  {
    label: S.nav.products,
    route: { name: 'products' },
    matches: ['products', 'product', 'product-new', 'product-edit'],
  },
  { label: S.nav.stock, route: { name: 'stock' }, matches: ['stock'] },
  { label: S.nav.import, route: { name: 'import' }, matches: ['import'] },
];

export function Shell() {
  const { store, platform } = useServices();
  const { route, navigate } = useRoute();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">{PRODUCT.name}</div>
        <div className="store-name">{store.branchName}</div>
        <nav aria-label="Main">
          {NAV.map((item) => (
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
          {S.nav.till} {store.tillCode} · {store.userName}
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
