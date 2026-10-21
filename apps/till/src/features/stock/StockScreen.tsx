import { INVENTORY } from '@app/config';
import { formatExpiry, formatMoney, formatQty } from '@app/core';
import { getStockSummary, listStock, type StockFilter } from '@app/db';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useRoute } from '../../app/router';
import { useServices } from '../../app/services';
import { EXPIRY_LABEL, EXPIRY_TONE, productTitle } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';
import { S } from '../../strings';
import { Badge, EmptyState, Notice, PageHeader, TextInput } from '../../ui';

const FILTERS: StockFilter[] = ['in_stock', 'near_expiry', 'expired'];

export function StockScreen() {
  const { ctx } = useServices();
  const { navigate } = useRoute();
  const [filter, setFilter] = useState<StockFilter>('in_stock');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 150);

  const summary = useQuery({ queryKey: ['stock-summary'], queryFn: () => getStockSummary(ctx) });
  const rows = useQuery({
    queryKey: ['stock-list', filter, debounced],
    queryFn: () => listStock(ctx, { filter, search: debounced }),
    placeholderData: keepPreviousData,
  });
  const s = summary.data;

  return (
    <div className="page">
      <PageHeader title={S.stock.title} />
      {s && (
        <>
          <div className="summary-cards">
            <div className="summary-card">
              <div className="muted">{S.stock.stockValue}</div>
              <div className="stat">{formatMoney(s.stockValue)}</div>
            </div>
            <div className="summary-card summary-bad">
              <div className="muted">{S.stock.expiredValue}</div>
              <div className="stat">{formatMoney(s.expiredValue)}</div>
              <div className="muted">{S.stock.batches(s.expiredBatches)}</div>
            </div>
            <div className="summary-card summary-warn">
              <div className="muted">{S.stock.nearValue(INVENTORY.nearExpiryDays)}</div>
              <div className="stat">{formatMoney(s.nearExpiryValue)}</div>
              <div className="muted">{S.stock.batches(s.nearExpiryBatches)}</div>
            </div>
          </div>
          {s.batchesWithoutCost > 0 && (
            <Notice tone="warn">{S.stock.withoutCost(s.batchesWithoutCost)}</Notice>
          )}
        </>
      )}

      <div className="toolbar">
        <div className="tabs" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`tab ${filter === f ? 'active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {S.stock.filters[f]}
            </button>
          ))}
        </div>
        <TextInput
          type="search"
          aria-label={S.stock.search}
          placeholder={S.stock.search}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {rows.data && rows.data.length === 0 ? (
        <EmptyState>{S.stock.empty}</EmptyState>
      ) : (
        <table className="table table-hover">
          <thead>
            <tr>
              <th>{S.stock.product}</th>
              <th>{S.detail.batch}</th>
              <th>{S.detail.expiry}</th>
              <th>{S.stock.daysLeft}</th>
              <th className="num">{S.detail.qty}</th>
              <th className="num">{S.detail.value}</th>
            </tr>
          </thead>
          <tbody>
            {rows.data?.map((row) => (
              <tr
                key={row.batchId}
                onClick={() => navigate({ name: 'product', id: row.productId })}
              >
                <td>
                  <div className="cell-title">
                    {productTitle({ name: row.productName, strength: row.strength })}
                  </div>
                </td>
                <td>{row.batchNo || <span className="muted">{S.detail.noBatch}</span>}</td>
                <td>{row.expiryDate ? formatExpiry(row.expiryDate) : S.detail.noExpiry}</td>
                <td>
                  <Badge tone={EXPIRY_TONE[row.status]}>
                    {row.daysToExpiry === null
                      ? EXPIRY_LABEL[row.status]
                      : S.expiry.days(row.daysToExpiry)}
                  </Badge>
                </td>
                <td className="num">{formatQty(row.qty, row.units)}</td>
                <td className="num">
                  {row.value === null ? S.common.none : formatMoney(row.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
