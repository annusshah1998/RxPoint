import {
  addItem,
  bumpQty,
  can,
  cycleUnit,
  defaultSaleUnit,
  displayQty,
  formatExpiry,
  formatMoney,
  formatQty,
  lineQtyProblem,
  looksLikeBarcode,
  parseQtyInput,
  parseScanInput,
  priceForQty,
  removeLine,
  selectLine,
  setPrice,
  undoRemove,
  uuidv7,
  type Cart,
  type CartLine,
} from '@app/core';
import {
  discardDraft,
  findByScan,
  getOpenShift,
  getSellable,
  getStoreSettings,
  searchProducts,
  type ProductHit,
  type SaleWarning,
  type SalePlan,
} from '@app/db';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useRoute } from '../../app/router';
import { useServices } from '../../app/services';
import { productTitle } from '../../lib/format';
import { useDebounced } from '../../lib/use-debounced';
import { S } from '../../strings';
import { Badge, Button, Card, Loading, Notice, PageHeader, TextInput } from '../../ui';
import { DiscountDialog } from './DiscountDialog';
import { HeldDialog, HoldDialog } from './HoldDialogs';
import { PayDialog } from './PayDialog';
import { useSale } from './use-sale';

type Dialog =
  | { kind: 'pay' }
  | { kind: 'hold' }
  | { kind: 'held' }
  | { kind: 'discount'; lineKey: string | null }
  | null;

export function SaleScreen() {
  const { ctx } = useServices();
  const { navigate } = useRoute();
  const shift = useQuery({ queryKey: ['shift'], queryFn: () => getOpenShift(ctx) });

  if (shift.isPending) return <Loading />;
  if (!shift.data) {
    return (
      <div className="page">
        <PageHeader title={S.sale.title} />
        <Card className="narrow-card">
          <h2 className="card-title">{S.sale.noShift}</h2>
          <p className="muted">{S.sale.noShiftIntro}</p>
          <Button variant="primary" onClick={() => navigate({ name: 'shift' })}>
            {S.sale.openShift}
          </Button>
        </Card>
      </div>
    );
  }
  return <Till />;
}

function Till() {
  const { ctx, store } = useServices();
  const sale = useSale();
  const { cart, update, plan } = sale;
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => getStoreSettings(ctx) });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [message, setMessage] = useState<string | null>(null);
  const scanRef = useRef<HTMLInputElement>(null);

  const focusScan = useCallback(() => window.setTimeout(() => scanRef.current?.focus(), 0), []);

  const addFromText = useCallback(
    async (text: string, hit: ProductHit | null): Promise<boolean> => {
      if (!cart) return false;
      const { qtyText, term } = parseScanInput(text);
      let unitId: string | null = null;
      let item;
      if (!hit && looksLikeBarcode(term)) {
        const found = await findByScan(ctx, term);
        if (!found) {
          setMessage(S.sale.noBarcode(term));
          return false;
        }
        item = found.item;
        unitId = found.unitId;
      } else {
        const target = hit ?? (await searchProducts(ctx, term, { limit: 1 }))[0];
        if (!target) {
          setMessage(S.sale.noMatch(term));
          return false;
        }
        unitId = target.scannedUnitId ?? null;
        item = await getSellable(ctx, target.id);
        if (!item) return false;
      }
      if (!item.isActive) {
        setMessage(S.sale.archived(item.product.name));
        return false;
      }
      const sellable = item.product.units.filter((u) => u.isSellable);
      const unit =
        sellable.find((u) => u.id === unitId) ??
        defaultSaleUnit(item.product.units, settings.data?.defaultSaleUnit ?? 'strip');
      let qty = unit.qty;
      if (qtyText) {
        const parsed = parseQtyInput(qtyText, sellable, unit);
        if (!parsed.ok) {
          setMessage(S.sale.badQty);
          return false;
        }
        qty = parsed.baseQty;
      }
      if (lineQtyProblem(qty)) {
        setMessage(S.sale.tooMany);
        return false;
      }
      const ok = update((c) => addItem(c, item.product, unit.id, qty, uuidv7()));
      if (!ok) setMessage(S.sale.tooMany);
      else setMessage(null);
      return ok;
    },
    [cart, ctx, settings.data, update],
  );

  // Function keys work wherever the focus is on this screen.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (dialog) return;
      if (e.key === 'F9') {
        e.preventDefault();
        if (cart && cart.lines.length > 0) setDialog({ kind: 'pay' });
      } else if (e.key === 'F8') {
        e.preventDefault();
        if (e.shiftKey) setDialog({ kind: 'held' });
        else if (cart && cart.lines.length > 0) setDialog({ kind: 'hold' });
      } else if (e.key === 'F6') {
        e.preventDefault();
        if (!cart || cart.lines.length === 0) return;
        setDialog({ kind: 'discount', lineKey: e.shiftKey ? null : cart.selectedKey });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cart, dialog]);

  if (!cart) return <Loading />;
  const close = () => {
    setDialog(null);
    focusScan();
  };

  return (
    <div className="till">
      <div className="till-main">
        <div className="till-header">
          <h1 className="page-title">{S.sale.title}</h1>
          <div className="till-status">
            {sale.saveState === 'failed' && <Badge tone="bad">{S.sale.notSaved}</Badge>}
            <span className="muted">
              {S.nav.till} {store.tillCode} · {store.userName}
            </span>
          </div>
        </div>
        {sale.notice && (
          <Notice tone="info">
            {sale.notice === 'restored' ? S.sale.restored : sale.notice}{' '}
            <Button size="small" variant="ghost" onClick={sale.clearNotice}>
              {S.common.close}
            </Button>
          </Notice>
        )}
        {plan?.warnings
          .filter((w) => w.kind === 'clock_behind')
          .map((w) => (
            <Notice key="clock" tone="warn">
              {w.kind === 'clock_behind' && w.message}
            </Notice>
          ))}
        <ScanBox inputRef={scanRef} onAdd={addFromText} cart={cart} update={update} />
        {message && <Notice tone="warn">{message}</Notice>}
        <CartTable cart={cart} plan={plan} update={update} onFocusScan={focusScan} />
        <p className="muted till-keys">{S.sale.keysHint}</p>
      </div>
      <TotalsPanel
        cart={cart}
        plan={plan}
        onPay={() => setDialog({ kind: 'pay' })}
        onHold={() => setDialog({ kind: 'hold' })}
        onHeld={() => setDialog({ kind: 'held' })}
        onLineDiscount={() => setDialog({ kind: 'discount', lineKey: cart.selectedKey })}
        onBillDiscount={() => setDialog({ kind: 'discount', lineKey: null })}
        onClear={async () => {
          if (!window.confirm(S.sale.clearConfirm)) return;
          await sale.flush();
          await discardDraft(ctx, { draftId: cart.id });
          await sale.reload();
          focusScan();
        }}
      />
      {dialog?.kind === 'pay' && <PayDialog sale={sale} onClose={close} />}
      {dialog?.kind === 'hold' && <HoldDialog sale={sale} onClose={close} />}
      {dialog?.kind === 'held' && <HeldDialog sale={sale} onClose={close} />}
      {dialog?.kind === 'discount' && (
        <DiscountDialog
          sale={sale}
          lineKey={dialog.lineKey}
          capBp={
            settings.data
              ? Math.max(
                  settings.data.discountCapBp[store.userRole],
                  settings.data.defaultDiscountBp,
                )
              : null
          }
          onClose={close}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scan box with search dropdown
// ---------------------------------------------------------------------------

function ScanBox({
  inputRef,
  onAdd,
  cart,
  update,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onAdd: (text: string, hit: ProductHit | null) => Promise<boolean>;
  cart: Cart;
  update: (change: (cart: Cart) => Cart) => boolean;
}) {
  const { ctx } = useServices();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const term = parseScanInput(text).term;
  const debounced = useDebounced(term, 120);
  const searching = debounced.length >= 2 && !looksLikeBarcode(debounced);
  const hits = useQuery({
    queryKey: ['sale-search', debounced],
    queryFn: () => searchProducts(ctx, debounced, { limit: 8 }),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  const results = searching && text.trim() ? (hits.data ?? []) : [];
  useEffect(() => setActive(0), [debounced]);

  async function submit(hit: ProductHit | null) {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      // A scan types fast and presses Enter before the search catches up: search afresh.
      const pick = hit ?? (term === debounced ? (results[active] ?? null) : null);
      if (await onAdd(text, pick)) setText('');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const empty = text.trim() === '';
    const key = cart.selectedKey;
    const index = cart.lines.findIndex((l) => l.key === key);
    if (e.key === 'Enter') {
      e.preventDefault();
      void submit(null);
    } else if (e.key === 'Escape') {
      setText('');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length > 0) setActive((i) => Math.min(i + 1, results.length - 1));
      else if (cart.lines.length > 0) {
        const next = cart.lines[Math.min(index + 1, cart.lines.length - 1)]!;
        update((c) => selectLine(c, next.key));
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length > 0) setActive((i) => Math.max(i - 1, 0));
      else if (cart.lines.length > 0) {
        const prev = cart.lines[Math.max(index - 1, 0)]!;
        update((c) => selectLine(c, prev.key));
      }
    } else if (empty && key && (e.key === '+' || e.key === '-')) {
      e.preventDefault();
      update((c) => bumpQty(c, key, e.key === '+' ? 1 : -1));
    } else if (empty && key && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      update((c) => cycleUnit(c, key, e.key === 'ArrowRight' ? 1 : -1));
    } else if (empty && key && e.key === 'Delete') {
      e.preventDefault();
      const line = cart.lines.find((l) => l.key === key)!;
      update((c) =>
        removeLine(
          c,
          key,
          cart.userId,
          new Date().toISOString(),
          priceForQty(line.price, line.qty),
        ),
      );
    } else if (e.ctrlKey && e.key.toLowerCase() === 'z' && empty) {
      e.preventDefault();
      update(undoRemove);
    }
  }

  return (
    <div className="scan-box">
      <TextInput
        ref={inputRef}
        className="scan-input"
        aria-label={S.sale.scanLabel}
        placeholder={S.sale.scanPlaceholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      {results.length > 0 && (
        <ul className="scan-results" role="listbox" aria-label={S.sale.scanLabel}>
          {results.map((hit, i) => (
            <li
              key={hit.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                void submit(hit);
              }}
            >
              <span className="scan-name">{productTitle(hit)}</span>
              <span className="muted">{hit.generics}</span>
              <span className="scan-stock">
                {S.sale.stockLeft(formatQty(Math.max(hit.stockQty, 0), hit.units))}
              </span>
              <span className="scan-price">{formatMoney(hit.salePrice)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

function chipsFor(line: CartLine, plan: SalePlan | undefined): React.ReactNode[] {
  const chips: React.ReactNode[] = [];
  if (line.rx === 'required')
    chips.push(
      <Badge key="rx" tone="info">
        {S.sale.chips.rx}
      </Badge>,
    );
  if (line.rx === 'controlled') {
    chips.push(
      <Badge key="ctl" tone="bad">
        {S.sale.chips.controlled(line.schedule ?? '')}
      </Badge>,
    );
  }
  for (const w of plan?.warnings ?? []) {
    if (!('lineKey' in w) || w.lineKey !== line.key) continue;
    const chip = warningChip(w, line);
    if (chip) chips.push(chip);
  }
  return chips;
}

function warningChip(w: SaleWarning, line: CartLine): React.ReactNode {
  const qty = (n: number) => formatQty(n, line.units);
  switch (w.kind) {
    case 'past_zero':
      return (
        <Badge key="pz" tone="warn">
          {S.sale.chips.pastZero(qty(w.recorded), qty(w.qty))}
        </Badge>
      );
    case 'above_mrp':
      return (
        <Badge key="mrp" tone="warn">
          {S.sale.chips.aboveMrp(formatMoney(w.over))}
        </Badge>
      );
    case 'near_expiry':
      return (
        <Badge key={`ne-${w.batchNo}`} tone="warn">
          {S.sale.chips.nearExpiry(w.batchNo, formatExpiry(w.expiryDate))}
        </Badge>
      );
    case 'expired_on_record':
      return (
        <Badge key="exp" tone="bad">
          {S.sale.chips.expiredOnRecord}
        </Badge>
      );
    case 'price_changed':
      return (
        <Badge key="pc" tone="info">
          {S.sale.chips.priceChanged(formatMoney(priceForQty(w.price, line.qty)))}
        </Badge>
      );
    case 'discount_dropped':
      return (
        <Badge key="dd" tone="warn">
          {S.sale.chips.discountDropped}
        </Badge>
      );
    default:
      return null;
  }
}

function CartTable({
  cart,
  plan,
  update,
  onFocusScan,
}: {
  cart: Cart;
  plan: SalePlan | undefined;
  update: (change: (cart: Cart) => Cart) => boolean;
  onFocusScan: () => void;
}) {
  if (cart.lines.length === 0) {
    return (
      <div className="cart-empty">
        {S.sale.empty}
        {cart.undo && (
          <Button size="small" variant="ghost" onClick={() => update(undoRemove)}>
            {S.sale.undo}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="cart">
      <table className="table cart-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{S.sale.item}</th>
            <th>{S.sale.qty}</th>
            <th className="num">{S.sale.rate}</th>
            <th className="num">{S.sale.discount}</th>
            <th className="num">{S.sale.amount}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {cart.lines.map((line, i) => {
            const planned = plan?.lines.find((l) => l.key === line.key);
            const unit = line.units.find((u) => u.id === line.unitId) ?? line.units[0]!;
            const price = planned?.price ?? line.price;
            const mrp = plan?.warnings.find(
              (w): w is Extract<SaleWarning, { kind: 'above_mrp' }> =>
                w.kind === 'above_mrp' && w.lineKey === line.key,
            );
            const discount = planned ? planned.lineDiscount + planned.billShare : 0;
            const field = plan?.fields;
            const problem = field
              ? Object.entries(field).find(([k]) => k.startsWith(`lines.${i}.`))?.[1]
              : undefined;
            return (
              <tr
                key={line.key}
                className={line.key === cart.selectedKey ? 'selected' : ''}
                onClick={() => {
                  update((c) => selectLine(c, line.key));
                  onFocusScan();
                }}
              >
                <td className="muted">{i + 1}</td>
                <td>
                  <div className="cart-name">{line.name}</div>
                  <div className="chips">
                    {chipsFor(line, plan)}
                    {mrp && (
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          update((c) => setPrice(c, line.key, mrp.mrpPrice, 'mrp'));
                        }}
                      >
                        {S.sale.chips.sellAtMrp}
                      </Button>
                    )}
                    {planned?.parts.some((p) => p.placeholder) && (
                      <Badge tone="neutral">{S.sale.chips.unrecorded}</Badge>
                    )}
                  </div>
                  {problem && <div className="field-error">{problem}</div>}
                </td>
                <td>{displayQty(line)}</td>
                <td className="num">
                  {formatMoney(priceForQty(price, unit.qty), { symbol: false })}
                  <span className="muted">/{unit.name}</span>
                </td>
                <td className="num">
                  {discount > 0 ? formatMoney(-discount, { symbol: false }) : ''}
                </td>
                <td className="num strong">
                  {formatMoney(planned?.net ?? priceForQty(price, line.qty), { symbol: false })}
                </td>
                <td>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`${S.sale.remove} ${line.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      update((c) =>
                        removeLine(
                          c,
                          line.key,
                          cart.userId,
                          new Date().toISOString(),
                          priceForQty(line.price, line.qty),
                        ),
                      );
                      onFocusScan();
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {cart.undo && (
        <Button size="small" variant="ghost" onClick={() => update(undoRemove)}>
          {S.sale.undo}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Totals and actions
// ---------------------------------------------------------------------------

function TotalsPanel({
  cart,
  plan,
  onPay,
  onHold,
  onHeld,
  onLineDiscount,
  onBillDiscount,
  onClear,
}: {
  cart: Cart;
  plan: SalePlan | undefined;
  onPay: () => void;
  onHold: () => void;
  onHeld: () => void;
  onLineDiscount: () => void;
  onBillDiscount: () => void;
  onClear: () => void;
}) {
  const { store } = useServices();
  const t = plan?.totals;
  const hasLines = cart.lines.length > 0;
  const row = (label: string, value: number, show = true) =>
    show ? (
      <div className="totals-row">
        <span>{label}</span>
        <span>{formatMoney(value, { symbol: false })}</span>
      </div>
    ) : null;
  return (
    <aside className="till-side" aria-label={S.sale.total}>
      <div className="totals">
        {row(S.sale.itemsTotal, t?.grossTotal ?? 0)}
        {row(S.sale.itemDiscounts, -(t?.lineDiscountTotal ?? 0), (t?.lineDiscountTotal ?? 0) > 0)}
        {row(S.sale.billDiscount, -(t?.billDiscount ?? 0), (t?.billDiscount ?? 0) > 0)}
        {row(S.sale.rounding, t?.rounding ?? 0, (t?.rounding ?? 0) !== 0)}
        <div className="totals-grand" data-testid="sale-total">
          <span>{S.sale.total}</span>
          <span>{formatMoney(hasLines ? (t?.total ?? 0) : 0)}</span>
        </div>
        <div className="muted">{S.sale.lines(cart.lines.length)}</div>
      </div>
      <div className="till-actions">
        <Button variant="primary" className="pay-button" disabled={!hasLines} onClick={onPay}>
          {S.sale.pay} <kbd>{S.sale.payKey}</kbd>
        </Button>
        <Button disabled={!hasLines} onClick={onHold}>
          {S.sale.hold} <kbd>{S.sale.holdKey}</kbd>
        </Button>
        <Button onClick={onHeld}>
          {S.sale.held} <kbd>{S.sale.heldKey}</kbd>
        </Button>
        <Button disabled={!hasLines || !cart.selectedKey} onClick={onLineDiscount}>
          {S.sale.lineDiscount} <kbd>{S.sale.lineDiscountKey}</kbd>
        </Button>
        <Button disabled={!hasLines} onClick={onBillDiscount}>
          {S.sale.billDiscountButton} <kbd>{S.sale.billDiscountKey}</kbd>
        </Button>
        {can(store.userRole, 'sale.sell') && hasLines && (
          <Button variant="ghost" onClick={onClear}>
            {S.sale.clear}
          </Button>
        )}
      </div>
    </aside>
  );
}
