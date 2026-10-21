import { describeUnitLadder, formatExpiry, formatMoney, formatQty, pricePerUnit } from '@app/core';
import {
  getProduct,
  getProductStock,
  setProductActive,
  type BatchStock,
  type ProductDetail,
} from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useRoute } from '../../app/router';
import { useAction, useServices } from '../../app/services';
import { errorMessage } from '../../lib/errors';
import {
  EXPIRY_LABEL,
  EXPIRY_TONE,
  formLabel,
  formatPackPrice,
  productTitle,
  unitLabel,
} from '../../lib/format';
import { S } from '../../strings';
import { Badge, Button, Card, EmptyState, Loading, Notice, PageHeader } from '../../ui';
import { AdjustStockDialog } from './AdjustStockDialog';
import { OpeningStockForm } from './OpeningStockForm';

export function ProductDetailScreen({ productId }: { productId: string }) {
  const { ctx } = useServices();
  const { navigate, back } = useRoute();
  const product = useQuery({
    queryKey: ['product', productId],
    queryFn: () => getProduct(ctx, productId),
  });
  const archive = useAction((c, active: boolean) => setProductActive(c, productId, active));

  if (product.isPending) return <Loading />;
  if (!product.data) return <EmptyState>{S.product.notFound}</EmptyState>;
  const p = product.data;

  return (
    <div className="page">
      <PageHeader
        onBack={back}
        title={
          <>
            {productTitle(p)} {p.rxRequired && <Badge tone="info">{S.product.rx}</Badge>}
            {p.controlledSchedule && (
              <Badge tone="warn">{S.product.controlledBadge(p.controlledSchedule)}</Badge>
            )}
            {!p.isActive && <Badge>{S.product.archived}</Badge>}
          </>
        }
        subtitle={[formLabel(p.form), p.manufacturer].filter(Boolean).join(' · ')}
        actions={
          <>
            <Button onClick={() => navigate({ name: 'product-edit', id: p.id })}>
              {S.common.edit}
            </Button>
            <Button
              variant="ghost"
              disabled={archive.isPending}
              onClick={() => {
                if (p.isActive && !window.confirm(S.product.archiveConfirm)) return;
                archive.mutate(!p.isActive);
              }}
            >
              {p.isActive ? S.product.archive : S.product.restore}
            </Button>
          </>
        }
      />
      {archive.isError && <Notice tone="bad">{errorMessage(archive.error)}</Notice>}
      <div className="detail-grid">
        <ProductFacts product={p} />
        <div className="form-column">
          <StockCard product={p} />
          {p.isActive && <OpeningStockForm product={p} />}
        </div>
      </div>
    </div>
  );
}

function ProductFacts({ product: p }: { product: ProductDetail }) {
  const prices = pricePerUnit({ amount: p.salePrice, perQty: p.priceQty }, p.units);
  const barcodes = p.units.filter((u) => u.barcodes.length > 0);
  return (
    <Card>
      <dl className="facts">
        <dt>{S.detail.salts}</dt>
        <dd>
          {p.ingredients.length === 0
            ? S.common.none
            : p.ingredients
                .map((i) => [i.generic, i.strength].filter(Boolean).join(' '))
                .join(' + ')}
        </dd>
        <dt>{S.detail.packs}</dt>
        <dd>{describeUnitLadder(p.units)}</dd>
        <dt>{S.detail.prices}</dt>
        <dd>
          <ul className="plain-list">
            {prices.map(({ unit, amount }) => (
              <li key={unit.id}>
                1 {unit.name}: <strong>{formatMoney(amount)}</strong>
                {!unit.isSellable && <span className="muted"> {S.detail.notSoldSingly}</span>}
              </li>
            ))}
          </ul>
        </dd>
        <dt>{S.detail.cost}</dt>
        <dd>
          {p.costPrice === null ? S.common.none : formatPackPrice(p.costPrice, p.priceQty, p.units)}
        </dd>
        <dt>{S.detail.barcodes}</dt>
        <dd>
          {barcodes.length === 0
            ? S.common.none
            : barcodes.map((u) => (
                <div key={u.id}>
                  {u.name}: <code>{u.barcodes.join(', ')}</code>
                </div>
              ))}
        </dd>
        <dt>{S.detail.rack}</dt>
        <dd>{p.rack ?? S.common.none}</dd>
        <dt>{S.detail.reorder}</dt>
        <dd>{p.reorderLevel === null ? S.common.none : formatQty(p.reorderLevel, p.units)}</dd>
        {p.notes && (
          <>
            <dt>{S.product.notes}</dt>
            <dd>{p.notes}</dd>
          </>
        )}
      </dl>
    </Card>
  );
}

function StockCard({ product }: { product: ProductDetail }) {
  const { ctx } = useServices();
  const [adjusting, setAdjusting] = useState<BatchStock | null>(null);
  const stock = useQuery({
    queryKey: ['product-stock', product.id],
    queryFn: () => getProductStock(ctx, product.id),
  });
  if (!stock.data) return <Loading />;
  const { totalQty, sellableQty, batches } = stock.data;

  return (
    <Card title={S.detail.stock}>
      <div className="stat-row">
        <div>
          <div className="muted">{S.detail.onHand}</div>
          <div className="stat" data-testid="stock-on-hand">
            {formatQty(totalQty, product.units)}
          </div>
        </div>
        {sellableQty !== totalQty && (
          <div>
            <div className="muted">{S.detail.sellable}</div>
            <div className="stat">{formatQty(sellableQty, product.units)}</div>
          </div>
        )}
      </div>
      {batches.length === 0 ? (
        <p className="muted">{S.detail.noStock}</p>
      ) : (
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{S.detail.batch}</th>
              <th>{S.detail.expiry}</th>
              <th>{S.detail.status}</th>
              <th className="num">{S.detail.qty}</th>
              <th className="num">{S.detail.mrp}</th>
              <th className="num">{S.detail.value}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.batchId}>
                <td>{b.batchNo || <span className="muted">{S.detail.noBatch}</span>}</td>
                <td>{b.expiryDate ? formatExpiry(b.expiryDate) : S.detail.noExpiry}</td>
                <td>
                  <Badge tone={EXPIRY_TONE[b.status]}>{EXPIRY_LABEL[b.status]}</Badge>
                  {b.daysToExpiry !== null && b.status !== 'ok' && (
                    <span className="muted"> {S.expiry.days(b.daysToExpiry)}</span>
                  )}
                </td>
                <td className="num">{formatQty(b.qty, product.units)}</td>
                <td className="num">
                  {b.mrp === null
                    ? S.common.none
                    : `${formatMoney(b.mrp)} / ${unitLabel(product.units, b.packQty)}`}
                </td>
                <td className="num">{b.value === null ? S.common.none : formatMoney(b.value)}</td>
                <td>
                  <Button size="small" variant="ghost" onClick={() => setAdjusting(b)}>
                    {S.detail.adjust}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adjusting && (
        <AdjustStockDialog product={product} batch={adjusting} onClose={() => setAdjusting(null)} />
      )}
    </Card>
  );
}
