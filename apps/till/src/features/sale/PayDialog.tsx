import {
  AppError,
  WALLET_PROVIDERS,
  confirmInDate,
  effectiveCapBp,
  formatExpiry,
  formatMoney,
  formatQty,
  isAppError,
  isSuspiciousTender,
  parseMoney,
  setPrescription,
  setRxCheck,
  settleTenders,
  suggestCash,
  toMajorString,
  type Tender,
  type WalletProvider,
} from '@app/core';
import {
  DEFAULT_DEVICE_SETTINGS,
  completeSale,
  getDeviceSettings,
  getStoreSettings,
  grantApproval,
  planSale,
  startDraft,
  type CompletedSale,
  type SalePlan,
} from '@app/db';
import type { ReceiptDocument } from '@app/receipt';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { keyLetter, onlyMods } from '../../app/keys';
import { useServices } from '../../app/services';
import { errorMessage, fieldErrors, isApprovalError } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Checkbox, Field, Loading, Modal, Notice, Select, TextInput } from '../../ui';
import { ApprovalFields, type ApprovalValue } from '../auth/ApprovalFields';
import { ReceiptOutput } from '../printing/PrintStatus';
import { loadReceipt, usePrinting, type PrintOutcome } from '../printing/printing';
import type { SaleState } from './use-sale';
import { useScanGuard } from './use-scan-guard';

type Stage =
  | { kind: 'checking' }
  | { kind: 'blocked'; problems: string[] }
  | { kind: 'confirm' }
  | {
      kind: 'approve';
      need: { kind: 'sale.discount' | 'sale.controlled'; lineKey: string; needBp?: number };
    }
  | { kind: 'tender' }
  | {
      kind: 'done';
      result: CompletedSale;
      receipt: ReceiptDocument | null;
      printed: PrintOutcome;
    };

interface OtherTender {
  id: number;
  method: 'card' | 'wallet';
  provider: WalletProvider;
  amount: string;
  reference: string;
  received: boolean;
}

const noApproval: ApprovalValue = { userId: '', pin: '' };

export function PayDialog({ sale, onClose }: { sale: SaleState; onClose: () => void }) {
  const { ctx } = useServices();
  const printing = usePrinting();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => getStoreSettings(ctx) });
  const [stage, setStage] = useState<Stage>({ kind: 'checking' });
  const [plan, setPlan] = useState<SalePlan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<ApprovalValue>(noApproval);
  const [cash, setCash] = useState('');
  const [others, setOthers] = useState<OtherTender[]>([]);
  // The cash text the large-tender question was asked for; Enter again with it confirms.
  const [askedLarge, setAskedLarge] = useState<string | null>(null);
  const [scanIgnored, setScanIgnored] = useState(false);
  const cashRef = useRef<HTMLInputElement>(null);
  const cart = sale.cart!;

  // A scan while paying goes nowhere: the field it typed into is put back and its Enter
  // neither completes the sale nor presses a button. A barcode never becomes a tender.
  useScanGuard(() => {
    setScanIgnored(true);
    return true;
  }, stage.kind !== 'done');

  /** Saves the cart, prices it afresh and moves to the step it needs next. */
  const check = useCallback(async () => {
    setStage({ kind: 'checking' });
    await sale.flush();
    const fresh = await planSale(ctx, sale.cart!);
    setPlan(fresh);
    const problems = [
      ...(fresh.notAvailable ? [fresh.notAvailable] : []),
      ...Object.values(fresh.fields),
    ];
    if (problems.length > 0) setStage({ kind: 'blocked', problems });
    else if (fresh.confirm.length > 0) setStage({ kind: 'confirm' });
    else {
      const discount = fresh.needs.find((n) => n.kind === 'sale.discount');
      if (discount) setStage({ kind: 'approve', need: discount });
      else setStage({ kind: 'tender' });
    }
    return fresh;
  }, [ctx, sale]);

  useEffect(() => {
    void check();
    // Only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (stage.kind === 'tender') window.setTimeout(() => cashRef.current?.focus(), 0);
  }, [stage.kind]);

  const total = plan?.totals?.total ?? 0;
  const rxNeeded = !!plan?.warnings.some((w) => w.kind === 'rx');
  const controlled = !!plan?.warnings.some((w) => w.kind === 'controlled');

  function tenders(): Tender[] {
    const list: Tender[] = [];
    for (const o of others) {
      const amount = parseMoney(o.amount) ?? 0;
      if (o.method === 'card')
        list.push({ method: 'card', amount, reference: o.reference || null });
      else list.push({ method: 'wallet', provider: o.provider, amount, reference: o.reference });
    }
    const nonCash = list.reduce((s, t) => s + ('amount' in t ? t.amount : 0), 0);
    const typed = cash.trim() ? parseMoney(cash) : null;
    if (typed !== null && typed > 0) list.unshift({ method: 'cash', tendered: typed });
    else if (!cash.trim() && total - nonCash > 0) {
      // Enter with nothing typed: exact cash.
      list.unshift({ method: 'cash', tendered: total - nonCash });
    }
    return list;
  }

  const settled = plan?.totals ? settleTenders(total, tenders()) : null;
  const nonCashTotal = others.reduce((s, o) => s + (parseMoney(o.amount) ?? 0), 0);
  const typedCash = cash.trim() ? parseMoney(cash) : null;
  const suspicious =
    typedCash !== null && isSuspiciousTender(Math.max(total - nonCashTotal, 0), typedCash);

  async function complete(e?: FormEvent) {
    e?.preventDefault();
    if (busy || !plan?.totals) return;
    setScanIgnored(false);
    // Far more cash than the bill (a typo, or a barcode typed by hand) needs a second Enter.
    if (suspicious && askedLarge !== cash) {
      setAskedLarge(cash);
      return;
    }
    if (others.some((o) => o.method === 'wallet' && !o.received)) {
      setError(new AppError('VALIDATION', S.pay.walletReceived));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sale.flush();
      const result = await completeSale(ctx, {
        draftId: cart.id,
        tenders: tenders(),
        expectedTotal: total,
      });
      // The sale is saved. Nothing from here on may undo or hold it up: a receipt that
      // can't be built or printed is reported, and the boot notice asks about it later.
      let device = DEFAULT_DEVICE_SETTINGS;
      let receipt: ReceiptDocument | null = null;
      try {
        device = await getDeviceSettings(ctx);
        receipt = await loadReceipt(ctx, { docType: 'sale', docId: result.saleId }, device);
      } catch (err) {
        console.error(err);
      }
      // Printing runs in the background, after the change panel is up.
      const printed = printing.afterDocument({
        doc: receipt,
        settings: device,
        cashMoved: result.openDrawer,
        ref: { docType: 'sale', docId: result.saleId },
        title: S.printer.receiptTitle(result.invoiceNo),
      });
      setStage({ kind: 'done', result, receipt, printed });
      await queryClient.invalidateQueries();
    } catch (err) {
      if (
        isAppError(err) &&
        err.code === 'NEEDS_APPROVAL' &&
        err.details.permission === 'sale.controlled'
      ) {
        setStage({ kind: 'approve', need: { kind: 'sale.controlled', lineKey: '' } });
      } else if (
        isAppError(err) &&
        (err.code === 'NEEDS_CONFIRMATION' ||
          err.code === 'NEEDS_APPROVAL' ||
          err.code === 'TOTAL_CHANGED')
      ) {
        await check();
        if (err.code === 'TOTAL_CHANGED') setError(err);
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  async function approve(e: FormEvent) {
    e.preventDefault();
    if (stage.kind !== 'approve' || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sale.flush();
      await grantApproval(ctx, {
        draftId: cart.id,
        kind: stage.need.kind,
        lineKey: stage.need.lineKey,
        userId: approval.userId,
        pin: approval.pin,
      });
      setApproval(noApproval);
      if (stage.need.kind === 'sale.controlled') {
        setStage({ kind: 'tender' });
        setBusy(false);
        await complete();
        return;
      }
      await check();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function newSale() {
    const next = await startDraft(ctx);
    sale.replace(next.cart);
    onClose();
  }

  const [focusTender, setFocusTender] = useState<number | null>(null);
  useEffect(() => {
    if (focusTender === null) return;
    document
      .querySelector<HTMLElement>(`[data-tender="${focusTender}"] :is(select, input)`)
      ?.focus();
    setFocusTender(null);
  }, [focusTender]);

  /** Adds a card or wallet row for what is still to pay, and puts the cursor in it. */
  const addTender = useCallback(
    (method: OtherTender['method']) => {
      const id = Date.now() + others.length;
      setOthers((list) => [
        ...list,
        {
          id,
          method,
          provider: 'jazzcash',
          amount: toMajorString(Math.max(total - nonCashTotal, 0)),
          reference: '',
          received: false,
        },
      ]);
      setFocusTender(id);
    },
    [others.length, total, nonCashTotal],
  );

  // Alt+Y / Alt+N answer "Prescription seen?"; Alt+K / Alt+W add a card / wallet row.
  useEffect(() => {
    if (stage.kind !== 'tender') return;
    const onKey = (e: KeyboardEvent) => {
      if (!onlyMods(e, { alt: true })) return;
      const k = keyLetter(e);
      if (rxNeeded && (k === 'y' || k === 'n')) {
        e.preventDefault();
        sale.update((c) => setRxCheck(c, k === 'y' ? 'seen' : 'not_seen'));
      } else if (total > 0 && (k === 'k' || k === 'w')) {
        e.preventDefault();
        addTender(k === 'k' ? 'card' : 'wallet');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stage.kind, rxNeeded, sale, total, addTender]);

  const fields = fieldErrors(error);
  const title = stage.kind === 'done' ? S.pay.doneTitle : S.pay.title;

  return (
    <Modal title={title} onClose={stage.kind === 'done' ? () => void newSale() : onClose}>
      {scanIgnored && stage.kind !== 'done' && <Notice tone="warn">{S.pay.scanIgnored}</Notice>}
      {stage.kind === 'checking' && <Loading />}

      {stage.kind === 'blocked' && (
        <>
          <Notice tone="bad">{S.pay.fixFirst}</Notice>
          <ul>
            {stage.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <Button onClick={onClose}>{S.common.close}</Button>
        </>
      )}

      {stage.kind === 'confirm' && plan && (
        <>
          <h3>{S.pay.inDateTitle}</h3>
          {plan.confirm.map((c) => {
            const line = cart.lines.find((l) => l.key === c.key);
            if (!line) return null;
            const q = (n: number) => formatQty(n, line.units);
            const expired = c.expiredBatches
              .map((b) => `${b.batchNo || '—'} (${formatExpiry(b.expiryDate)}) ${q(b.qty)}`)
              .join(', ');
            return (
              <p key={c.key}>{S.pay.inDateLine(line.name, q(c.inDate), q(c.shortfall), expired)}</p>
            );
          })}
          <p>
            <strong>{S.pay.inDateQuestion}</strong>
          </p>
          <div className="form-actions">
            <Button
              variant="primary"
              autoFocus
              onClick={async () => {
                sale.update((c) => plan.confirm.reduce((acc, x) => confirmInDate(acc, x.key), c));
                await check();
              }}
            >
              {S.pay.inDateYes}
            </Button>
            <Button onClick={onClose}>{S.common.cancel}</Button>
          </div>
        </>
      )}

      {stage.kind === 'approve' && (
        <form onSubmit={approve} noValidate>
          {error != null && !isApprovalError(error) && (
            <Notice tone="bad">{errorMessage(error)}</Notice>
          )}
          <ApprovalFields
            permission={stage.need.kind === 'sale.controlled' ? 'sale.controlled' : undefined}
            eligible={
              stage.need.kind === 'sale.discount' && settings.data
                ? (role) =>
                    effectiveCapBp(
                      settings.data!.discountCapBp[role],
                      settings.data!.defaultDiscountBp,
                    ) >= (stage.need.needBp ?? 0)
                : undefined
            }
            message={
              stage.need.kind === 'sale.discount'
                ? `${(stage.need.needBp ?? 0) / 100}% ${S.sale.discountInput.toLowerCase()}: ${S.approval.needs('a pharmacist or the owner')}`
                : undefined
            }
            value={approval}
            onChange={setApproval}
            errors={isApprovalError(error) ? fields : {}}
          />
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={busy}>
              {S.pay.approve}
            </Button>
            <Button onClick={onClose}>{S.common.cancel}</Button>
          </div>
        </form>
      )}

      {stage.kind === 'tender' && plan?.totals && (
        <form onSubmit={complete} noValidate>
          <div className="pay-total">
            <span>{S.pay.total}</span>
            <strong data-testid="pay-total">{formatMoney(total)}</strong>
          </div>
          {error != null && Object.keys(fields).length === 0 && (
            <Notice tone="bad">{errorMessage(error)}</Notice>
          )}
          {fields.tenders && <Notice tone="bad">{fields.tenders}</Notice>}

          {rxNeeded && (
            <div className="rx-choice" role="group" aria-label={S.pay.rxQuestion}>
              <span>{S.pay.rxQuestion}</span>
              <Button
                variant={cart.rxCheck === 'seen' ? 'primary' : 'secondary'}
                aria-pressed={cart.rxCheck === 'seen'}
                onClick={() => sale.update((c) => setRxCheck(c, 'seen'))}
              >
                {S.pay.rxSeen}
              </Button>
              <Button
                variant={cart.rxCheck === 'not_seen' ? 'primary' : 'secondary'}
                aria-pressed={cart.rxCheck === 'not_seen'}
                onClick={() => sale.update((c) => setRxCheck(c, 'not_seen'))}
              >
                {S.pay.rxNotSeen}
              </Button>
              <span className="muted">{S.pay.rxKeys}</span>
              {fields.rxCheck && <span className="field-error">{fields.rxCheck}</span>}
            </div>
          )}

          {controlled && (
            <fieldset className="prescription">
              <legend>{S.pay.prescription}</legend>
              <p className="muted">{S.pay.onePrescription}</p>
              <div className="row">
                <Field label={S.pay.patientName} error={fields['prescription.patientName']}>
                  <TextInput
                    value={cart.prescription?.patientName ?? ''}
                    onChange={(e) =>
                      sale.update((c) =>
                        setPrescription(c, {
                          patientName: e.target.value,
                          prescriberName: c.prescription?.prescriberName ?? '',
                          patientPhone: c.prescription?.patientPhone ?? null,
                          prescriberRegNo: c.prescription?.prescriberRegNo ?? null,
                        }),
                      )
                    }
                  />
                </Field>
                <Field label={S.pay.prescriberName} error={fields['prescription.prescriberName']}>
                  <TextInput
                    value={cart.prescription?.prescriberName ?? ''}
                    onChange={(e) =>
                      sale.update((c) =>
                        setPrescription(c, {
                          patientName: c.prescription?.patientName ?? '',
                          prescriberName: e.target.value,
                          patientPhone: c.prescription?.patientPhone ?? null,
                          prescriberRegNo: c.prescription?.prescriberRegNo ?? null,
                        }),
                      )
                    }
                  />
                </Field>
              </div>
            </fieldset>
          )}

          {total === 0 ? (
            <Notice tone="info">{S.pay.nothingToPay}</Notice>
          ) : (
            <>
              <Field label={S.pay.cash} hint={S.pay.cashHint} error={fields['tenders.0.amount']}>
                <TextInput
                  ref={cashRef}
                  value={cash}
                  onChange={(e) => setCash(e.target.value)}
                  inputMode="decimal"
                  placeholder={toMajorString(Math.max(total - nonCashTotal, 0))}
                />
              </Field>
              <div className="cash-suggestions">
                {suggestCash(Math.max(total - nonCashTotal, 0)).map((v) => (
                  <Button key={v} size="small" onClick={() => setCash(toMajorString(v))}>
                    {formatMoney(v)}
                  </Button>
                ))}
              </div>
              {suspicious && typedCash !== null && (
                <Notice tone="warn">
                  {askedLarge === cash
                    ? S.pay.confirmLarge(formatMoney(typedCash), formatMoney(total))
                    : S.pay.suspicious(formatMoney(typedCash))}
                </Notice>
              )}
              {others.map((o, i) => (
                <div key={o.id} className="tender-row" data-tender={o.id}>
                  {o.method === 'wallet' && (
                    <Field label={S.pay.walletProvider}>
                      <Select
                        value={o.provider}
                        onChange={(e) =>
                          setOthers((list) =>
                            list.map((x) =>
                              x.id === o.id
                                ? { ...x, provider: e.target.value as WalletProvider }
                                : x,
                            ),
                          )
                        }
                      >
                        {WALLET_PROVIDERS.map((p) => (
                          <option key={p} value={p}>
                            {S.receipt.wallets[p]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                  <Field
                    label={o.method === 'card' ? S.pay.cardAmount : S.pay.walletAmount}
                    error={fields[`tenders.${i + 1}.amount`] ?? fields[`tenders.${i}.amount`]}
                  >
                    <TextInput
                      value={o.amount}
                      inputMode="decimal"
                      onChange={(e) =>
                        setOthers((list) =>
                          list.map((x) => (x.id === o.id ? { ...x, amount: e.target.value } : x)),
                        )
                      }
                    />
                  </Field>
                  <Field
                    label={o.method === 'card' ? S.pay.cardRef : S.pay.walletRef}
                    error={fields[`tenders.${i + 1}.reference`] ?? fields[`tenders.${i}.reference`]}
                  >
                    <TextInput
                      value={o.reference}
                      onChange={(e) =>
                        setOthers((list) =>
                          list.map((x) =>
                            x.id === o.id ? { ...x, reference: e.target.value } : x,
                          ),
                        )
                      }
                    />
                  </Field>
                  {o.method === 'wallet' && (
                    <Checkbox
                      label={S.pay.walletReceived}
                      checked={o.received}
                      onChange={(received) =>
                        setOthers((list) =>
                          list.map((x) => (x.id === o.id ? { ...x, received } : x)),
                        )
                      }
                    />
                  )}
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => setOthers((list) => list.filter((x) => x.id !== o.id))}
                  >
                    {S.pay.removeTender}
                  </Button>
                </div>
              ))}
              <div className="cash-suggestions">
                <Button
                  size="small"
                  aria-keyshortcuts={S.pay.addCardKey}
                  onClick={() => addTender('card')}
                >
                  + {S.pay.addCard} <kbd>{S.pay.addCardKey}</kbd>
                </Button>
                <Button
                  size="small"
                  aria-keyshortcuts={S.pay.addWalletKey}
                  onClick={() => addTender('wallet')}
                >
                  + {S.pay.addWallet} <kbd>{S.pay.addWalletKey}</kbd>
                </Button>
                <Button size="small" disabled title={S.pay.khataSoon}>
                  Khata
                </Button>
              </div>
              <div className="pay-balance" data-testid="pay-balance">
                {settled?.ok ? (
                  <>
                    <span>{S.pay.change}</span>
                    <strong>{formatMoney(settled.change)}</strong>
                  </>
                ) : settled && !settled.ok && settled.problem === 'short' ? (
                  <>
                    <span>{S.pay.remaining}</span>
                    <strong>{formatMoney(settled.short ?? 0)}</strong>
                  </>
                ) : null}
              </div>
            </>
          )}
          <div className="form-actions">
            {/* With nothing to pay there is no cash box, so Enter needs the cursor here,
                also when an approval step had it before. */}
            <Button type="submit" variant="primary" disabled={busy} autoFocus={total === 0}>
              {S.pay.complete}
            </Button>
            <Button onClick={onClose}>{S.common.cancel}</Button>
          </div>
        </form>
      )}

      {stage.kind === 'done' && (
        <div className="done-panel">
          <div className="done-change">
            <span>{S.pay.changeDue}</span>
            <strong data-testid="change-due">{formatMoney(stage.result.change)}</strong>
          </div>
          <p>
            <strong>{S.pay.invoice(stage.result.invoiceNo)}</strong>
          </p>
          <ReceiptOutput
            doc={stage.receipt}
            outcome={stage.printed}
            title={S.printer.receiptTitle(stage.result.invoiceNo)}
          />
          <div className="form-actions">
            <Button variant="primary" autoFocus onClick={() => void newSale()}>
              {S.pay.newSale}
            </Button>
            <span className="muted">{S.pay.newSaleHint}</span>
          </div>
        </div>
      )}
    </Modal>
  );
}
