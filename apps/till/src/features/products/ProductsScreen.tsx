import { formatQty } from '@app/core';
import { searchProducts, type ProductHit } from '@app/db';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRoute } from '../../app/router';
import { useServices } from '../../app/services';
import { formLabel, formatPackPrice, productTitle } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';
import { S } from '../../strings';
import { Badge, Button, Checkbox, EmptyState, PageHeader, TextInput } from '../../ui';

// Remember the search when coming back from a product.
let lastQuery = '';

export function ProductsScreen() {
  const { ctx } = useServices();
  const { navigate } = useRoute();
  const [query, setQuery] = useState(lastQuery);
  const [showArchived, setShowArchived] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounced = useDebounced(query, 120);

  const { data: hits = [], isPending } = useQuery({
    queryKey: ['products', debounced, showArchived],
    queryFn: () => searchProducts(ctx, debounced, { limit: 100, includeInactive: showArchived }),
    placeholderData: keepPreviousData,
  });

  useEffect(() => {
    lastQuery = query;
  }, [query]);
  useEffect(() => setActive(0), [debounced]);

  const open = (hit: ProductHit) => navigate({ name: 'product', id: hit.id });

  async function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // Scanners type fast and press Enter, so search now rather than wait for the debounce.
      const fresh = query === debounced ? hits : await searchProducts(ctx, query, { limit: 100 });
      const scanned = fresh.find((h) => h.scannedUnitId);
      const target = scanned ?? fresh[query === debounced ? active : 0];
      if (target) open(target);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  }

  return (
    <div className="page">
      <PageHeader
        title={S.products.title}
        actions={
          <Button variant="primary" onClick={() => navigate({ name: 'product-new' })}>
            {S.products.newProduct}
          </Button>
        }
      />
      <div className="search-bar">
        <TextInput
          ref={inputRef}
          className="search-input"
          type="search"
          aria-label={S.products.searchLabel}
          placeholder={S.products.searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <Checkbox
          label={S.products.showArchived}
          checked={showArchived}
          onChange={setShowArchived}
        />
      </div>

      {!isPending && hits.length === 0 ? (
        <EmptyState>{debounced.trim() ? S.products.noMatches : S.products.emptyCatalog}</EmptyState>
      ) : (
        <table className="table table-hover">
          <thead>
            <tr>
              <th>{S.products.columns.product}</th>
              <th>{S.products.columns.form}</th>
              <th>{S.products.columns.manufacturer}</th>
              <th className="num">{S.products.columns.price}</th>
              <th className="num">{S.products.columns.stock}</th>
              <th>{S.products.columns.rack}</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((hit, i) => (
              <tr
                key={hit.id}
                className={i === active ? 'row-active' : ''}
                onClick={() => open(hit)}
                onMouseEnter={() => setActive(i)}
              >
                <td>
                  <div className="cell-title">
                    {productTitle(hit)}
                    {hit.rxRequired && <Badge tone="info">{S.product.rx}</Badge>}
                    {hit.controlledSchedule && (
                      <Badge tone="warn">{S.product.controlledBadge(hit.controlledSchedule)}</Badge>
                    )}
                    {!hit.isActive && <Badge>{S.product.archived}</Badge>}
                  </div>
                  {hit.generics && <div className="cell-sub">{hit.generics}</div>}
                </td>
                <td>{formLabel(hit.form)}</td>
                <td>{hit.manufacturer ?? S.common.none}</td>
                <td className="num">{formatPackPrice(hit.salePrice, hit.priceQty, hit.units)}</td>
                <td className="num">
                  {hit.stockQty > 0 ? (
                    formatQty(hit.stockQty, hit.units)
                  ) : hit.stockQty < 0 ? (
                    <Badge tone="bad">{formatQty(hit.stockQty, hit.units)}</Badge>
                  ) : (
                    <span className="muted">{S.products.outOfStock}</span>
                  )}
                </td>
                <td>{hit.rack ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
