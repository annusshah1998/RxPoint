import { expect, test, type Page } from '@playwright/test';
import { OWNER_PIN, addStaff, setUpTill, switchUser } from './helpers';

/**
 * M2a "done when": a full day of sales runs on one till. A cashier opens a shift with a
 * note count, rings up 31 mixed sales by keyboard (one is voided later), records cash in and
 * out, and closes the shift. Every figure on the closed shift's report must equal what this
 * test worked out itself, sale by sale, in paisa.
 */

type Money = number;
type Provider = 'jazzcash' | 'easypaisa' | 'raast';

interface Product {
  code: string;
  /** Price of one scanned pack (the unit the barcode is on), in paisa. */
  price: Money;
}

// Imported with plenty of stock, MRP equal to the price, far from expiry. Prices are per
// strip, box or bottle as printed, and the barcode is on that pack.
const CSV = [
  'name,strength,form,generic,manufacturer,barcode,pack_size,sale_price,price_unit,cost_price,mrp,rx_required,controlled,rack,reorder_level,batch_no,expiry,stock_qty,stock_unit',
  'Panadol,500mg,Tablet,Paracetamol,GSK,8964000000017,10x10,35.50,Strip,30.00,35.50,no,,A1,0,PN3001,12/2030,3000,Tablet',
  'Brufen,400mg,Tablet,Ibuprofen,Abbott,8964000000024,10x10,87.35,Strip,74.00,87.35,no,,A2,0,BF3002,12/2030,3000,Tablet',
  'Risek,20mg,Capsule,Omeprazole,Getz Pharma,8964000000031,2x7,410.00,Box,348.50,410.00,no,,A3,0,RS3003,12/2030,560,Capsule',
  'Calpol,120mg/5ml,Syrup,Paracetamol,GSK,8964000000048,,185.00,Bottle,157.25,185.00,no,,C1,0,CP3004,12/2030,100,Bottle',
  'Surbex-Z,,Tablet,Multivitamin + Zinc,Abbott,8964000000055,3x10,690.00,Box,586.50,690.00,no,,E2,0,SZ3005,12/2030,600,Tablet',
  'Flagyl,400mg,Tablet,Metronidazole,Sanofi,8964000000062,10x10,60.00,Strip,51.00,60.00,yes,,B1,0,FG3006,12/2030,2000,Tablet',
].join('\n');

const PAN: Product = { code: '8964000000017', price: 3550 };
const BRU: Product = { code: '8964000000024', price: 8735 };
const RIS: Product = { code: '8964000000031', price: 41000 };
const CAL: Product = { code: '8964000000048', price: 18500 };
const SUR: Product = { code: '8964000000055', price: 69000 };
/** Prescription required. */
const FLA: Product = { code: '8964000000062', price: 6000 };

const WALLET_LABEL: Record<Provider, string> = {
  jazzcash: 'JazzCash',
  easypaisa: 'Easypaisa',
  raast: 'Raast',
};

interface Item {
  product: Product;
  packs: number;
  /** Line discount, whole percent. */
  off?: number;
  /** Type this name instead of scanning the barcode. */
  search?: string;
}

type Bill = { percent: number } | { amount: Money };

/** How the customer pays. Amounts left out are "the rest of the bill". */
type Pay =
  | { kind: 'cash'; tendered?: Money }
  | { kind: 'card'; card?: Money; tendered?: Money }
  | {
      kind: 'wallet';
      provider: Provider;
      ref: string;
      amount?: Money;
      card?: Money;
      tendered?: Money;
    }
  | { kind: 'nothing' };

interface SaleSpec {
  items: Item[];
  bill?: Bill;
  rx?: 'seen' | 'not_seen';
  /** A discount above the cashier's 5% needs the owner's PIN. */
  approval?: boolean;
  pay: Pay;
}

/** What one completed sale should have recorded. */
interface Recorded {
  invoice: string;
  gross: Money;
  discounts: Money;
  rounding: Money;
  total: Money;
  cash: Money;
  card: Money;
  wallet: Partial<Record<Provider, Money>>;
}

// ---------------------------------------------------------------------------
// The test's own arithmetic, in paisa (halves away from zero, as docs/m2-design.md §3)
// ---------------------------------------------------------------------------

function divRound(n: number, d: number): number {
  const q = Math.trunc(n / d);
  const r = n - q * d;
  return 2 * Math.abs(r) >= Math.abs(d) ? q + Math.sign(n) * Math.sign(d) : q;
}

const percentOf = (value: Money, percent: number) => divRound(value * percent, 100);

/** Prices a bill: line discounts, then the bill discount, then round to the nearest rupee. */
function price(items: Item[], bill?: Bill) {
  let gross = 0;
  let lineOff = 0;
  for (const item of items) {
    const g = item.product.price * item.packs;
    gross += g;
    lineOff += item.off ? percentOf(g, item.off) : 0;
  }
  const after = gross - lineOff;
  const billOff = !bill ? 0 : 'percent' in bill ? percentOf(after, bill.percent) : bill.amount;
  const subtotal = after - billOff;
  const total = divRound(subtotal, 100) * 100;
  return { gross, discounts: lineOff + billOff, rounding: total - subtotal, total };
}

/** "1234.50", as a cashier types it. */
const typed = (v: Money) => `${Math.trunc(v / 100)}.${String(v % 100).padStart(2, '0')}`;

/** "Rs 1,234.50" or "-Rs 20.00", as the till shows money. */
function formatMoney(v: Money): string {
  const abs = Math.abs(v);
  const whole = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+$)/g, ',');
  return `${v < 0 ? '-' : ''}Rs ${whole}.${String(abs % 100).padStart(2, '0')}`;
}
const invoiceNo = (n: number) => `T1-${String(n).padStart(6, '0')}`;

// ---------------------------------------------------------------------------
// Driving the till
// ---------------------------------------------------------------------------

/** The grand total on the Sale screen. */
const saleTotal = (page: Page) => page.getByTestId('sale-total').locator('span').last();

/** Scans (or types) each item and applies its discounts, checking the total after each step. */
async function ringUpItems(page: Page, items: Item[], bill?: Bill, before: Item[] = []) {
  const scan = page.getByLabel('Scan or search');
  const done: Item[] = [...before];
  for (const item of items) {
    const text = item.search ?? item.product.code;
    await scan.fill(item.packs > 1 ? `${item.packs}*${text}` : text);
    await scan.press('Enter');
    done.push({ ...item, off: undefined });
    await expect(saleTotal(page)).toHaveText(formatMoney(price(done).total));
    if (item.off) {
      // F6: the new line is selected, the cursor goes to the discount box.
      await page.keyboard.press('F6');
      await expect(page.getByLabel('Discount', { exact: true })).toBeFocused();
      await page.keyboard.type(String(item.off));
      await page.keyboard.press('Enter');
      done[done.length - 1] = item;
      await expect(saleTotal(page)).toHaveText(formatMoney(price(done).total));
      await expect(scan).toBeFocused();
    }
  }
  if (bill) {
    await page.keyboard.press('Shift+F6');
    await expect(page.getByLabel('Discount', { exact: true })).toBeFocused();
    await page.keyboard.type('percent' in bill ? String(bill.percent) : `${bill.amount / 100}/-`);
    await page.keyboard.press('Enter');
    await expect(saleTotal(page)).toHaveText(formatMoney(price(done, bill).total));
    await expect(scan).toBeFocused();
  }
  return done;
}

/** F9 and pay. Returns what the sale should have recorded. */
async function pay(page: Page, spec: SaleSpec, all: Item[], invoice: string): Promise<Recorded> {
  const priced = price(all, spec.bill);
  const { total } = priced;
  await page.keyboard.press('F9');
  const dialog = page.getByRole('dialog', { name: 'Pay' });
  if (spec.approval) {
    // The owner approves at the counter with their PIN.
    const pin = dialog.getByLabel('Their PIN');
    await expect(pin).toBeFocused();
    await pin.fill(OWNER_PIN);
    await pin.press('Enter');
  }
  await expect(page.getByTestId('pay-total')).toHaveText(formatMoney(total));
  if (spec.rx) {
    await page.keyboard.press(spec.rx === 'seen' ? 'Alt+y' : 'Alt+n');
    await expect(
      dialog.getByRole('button', { name: spec.rx === 'seen' ? 'Seen' : 'Not seen', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
  }

  const cashBox = dialog.getByLabel('Cash received');
  const p = spec.pay;
  const tendered = p.kind === 'nothing' ? undefined : p.tendered;
  let card = 0;
  let wallet: Partial<Record<Provider, Money>> = {};
  if (p.kind === 'nothing') {
    await expect(dialog.getByText('Nothing to pay — press Enter to finish')).toBeVisible();
    await page.keyboard.press('Enter');
  } else {
    await expect(cashBox).toBeFocused();
    let last = cashBox;
    if (p.kind === 'card' || (p.kind === 'wallet' && p.card)) {
      // Alt+K: a card row for the rest of the bill, with the cursor in it.
      await page.keyboard.press('Alt+k');
      const cardBox = dialog.getByLabel('Card amount');
      await expect(cardBox).toBeFocused();
      await expect(cardBox).toHaveValue(typed(total));
      card = p.card ?? total;
      if (p.card) await cardBox.fill(typed(p.card));
      last = cardBox;
    }
    if (p.kind === 'wallet') {
      // Alt+W: a wallet row for what is left, starting on the wallet's name.
      await page.keyboard.press('Alt+w');
      const provider = dialog.getByLabel('Wallet', { exact: true });
      await expect(provider).toBeFocused();
      await provider.selectOption({ label: WALLET_LABEL[p.provider] });
      const amount = dialog.getByLabel('Amount', { exact: true });
      await expect(amount).toHaveValue(typed(total - card));
      if (p.amount) await amount.fill(typed(p.amount));
      wallet = { [p.provider]: p.amount ?? total - card };
      const ref = dialog.getByLabel('Transaction ID');
      await ref.fill(p.ref);
      await dialog.getByLabel('Money received — I checked the app or SMS').check();
      last = ref;
    }
    if (tendered !== undefined) {
      await cashBox.fill(typed(tendered));
      last = cashBox;
    }
    await last.press('Enter');
  }

  const nonCash = card + Object.values(wallet).reduce((s, v) => s + v, 0);
  const cash = total - nonCash;
  const change = tendered === undefined ? 0 : tendered - cash;
  if (tendered !== undefined && tendered > cash + 10_000 && tendered > 10 * cash) {
    // Over 10× the cash due and Rs 100 more: the till asks, and Enter again confirms.
    await expect(
      dialog.getByText(
        `Received ${formatMoney(tendered)} for a ${formatMoney(total)} bill? Enter to confirm`,
      ),
    ).toBeVisible();
    await page.keyboard.press('Enter');
  }

  await expect(page.getByText(`Invoice ${invoice}`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('change-due')).toHaveText(formatMoney(change));
  // Enter starts the next sale.
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();
  await expect(page.getByLabel('Scan or search')).toBeFocused();
  return { invoice, ...priced, cash, card, wallet };
}

test('a full day of sales on one till adds up on the shift report', async ({ page }) => {
  // About 45 s alone and 90 s beside the other specs on a 4-worker run; leave room for CI.
  test.setTimeout(300_000);
  const problems = await setUpTill(page);

  // The owner imports the stock list and adds a cashier.
  await page.getByRole('link', { name: 'Import' }).click();
  await page.locator('input[type=file]').setInputFiles({
    name: 'stock.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(CSV),
  });
  await page.getByRole('button', { name: 'Check rows' }).click();
  await expect(
    page.getByText('6 new products · 0 already in catalog · 6 stock lines · 0 rows with problems'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Import 6 rows' }).click();
  await expect(
    page.getByText('6 products created, 6 stock lines added, 0 rows failed.'),
  ).toBeVisible();
  await addStaff(page, 'Sana', 'Cashier', '1470');

  // Sana opens the shift with Rs 5,000 counted in notes.
  await switchUser(page, 'Sana', '1470');
  const float: Money = 500_000;
  await page.keyboard.press('Alt+5');
  await page.getByRole('button', { name: 'Count notes' }).click();
  await page.getByLabel('Rs 1,000 ×').fill('3');
  await page.getByLabel('Rs 500 ×').fill('3');
  await page.getByLabel('Rs 100 ×').fill('5');
  await expect(page.getByText(`Total: ${formatMoney(float)}`)).toBeVisible();
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1' })).toBeVisible();
  await page.keyboard.press('Alt+1');
  await expect(page.getByLabel('Scan or search')).toBeFocused();

  const sales: Recorded[] = [];
  const voided = new Set<string>();
  let cashIn: Money = 0;
  let cashOut: Money = 0;
  let rxNotSeen = 0;
  /** Rings up and pays one sale. `before`: lines already in the cart (a resumed sale). */
  const sell = async (spec: SaleSpec, before: Item[] = []) => {
    const all = await ringUpItems(page, spec.items, spec.bill, before);
    sales.push(await pay(page, spec, all, invoiceNo(sales.length + 1)));
    if (spec.rx === 'not_seen') rxNotSeen += 1;
  };

  /** Alt+C: cash into or out of the drawer, without leaving the Sale screen. */
  const moveCash = async (kind: 'Cash in' | 'Cash out', amount: Money, note: string) => {
    await page.keyboard.press('Alt+c');
    const dialog = page.getByRole('dialog', { name: 'Cash in or out of the drawer' });
    await expect(dialog.getByLabel('Amount')).toBeFocused();
    await page.keyboard.type(typed(amount));
    await dialog.getByLabel('In or out').selectOption({ label: kind });
    await dialog.getByLabel('Note').fill(note);
    await dialog.getByLabel('Note').press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByLabel('Scan or search')).toBeFocused();
    if (kind === 'Cash in') cashIn += amount;
    else cashOut += amount;
  };

  // ---- Morning ----
  await sell({ items: [{ product: PAN, packs: 2 }], pay: { kind: 'cash' } });
  await sell({ items: [{ product: BRU, packs: 1 }], pay: { kind: 'cash', tendered: 10_000 } });
  await moveCash('Cash in', 100_000, 'Change from the bank');
  await sell({
    items: [
      { product: RIS, packs: 1 },
      { product: CAL, packs: 1, search: 'calpol' },
    ],
    pay: { kind: 'card' },
  });
  await sell({
    items: [{ product: SUR, packs: 1 }],
    pay: { kind: 'wallet', provider: 'jazzcash', ref: 'JC100234' },
  });
  // 5% off a line is within the cashier's limit.
  await sell({
    items: [
      { product: PAN, packs: 3 },
      { product: BRU, packs: 2, off: 5 },
    ],
    pay: { kind: 'cash', tendered: 50_000 },
  });
  await sell({
    items: [{ product: CAL, packs: 2 }],
    bill: { percent: 3 },
    pay: { kind: 'card', card: 20_000 },
  });
  await sell({ items: [{ product: FLA, packs: 2 }], rx: 'seen', pay: { kind: 'cash' } });
  // 10% off a line needs the owner's PIN.
  await sell({
    items: [
      { product: SUR, packs: 1, off: 10 },
      { product: PAN, packs: 1 },
    ],
    approval: true,
    pay: { kind: 'wallet', provider: 'easypaisa', ref: 'EP55667788' },
  });

  // A customer goes back for a prescription: hold the sale (F8), serve the next one, then
  // bring it back (Shift+F8, Enter) and finish it.
  const held = await ringUpItems(page, [{ product: BRU, packs: 3 }]);
  await page.keyboard.press('F8');
  const note = page.getByLabel('Note (optional)');
  await expect(note).toBeFocused();
  await note.fill('Man in grey');
  await note.press('Enter');
  await expect(page.getByText('Scan an item or type its name to start.')).toBeVisible();
  await sell({ items: [{ product: RIS, packs: 2 }], pay: { kind: 'cash', tendered: 100_000 } });
  await page.keyboard.press('Shift+F8');
  const heldList = page.getByRole('dialog', { name: 'Held sales' });
  await expect(heldList.getByText('Man in grey')).toBeVisible();
  await expect(heldList.getByRole('button', { name: 'Resume' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(saleTotal(page)).toHaveText(formatMoney(price(held).total));
  await sell(
    { items: [{ product: CAL, packs: 1, search: 'calpol' }], pay: { kind: 'card' } },
    held,
  );

  // A free sample: 100% off needs the owner, and the bill comes to nothing.
  await sell({
    items: [{ product: PAN, packs: 1, off: 100 }],
    approval: true,
    pay: { kind: 'nothing' },
  });
  await sell({
    items: [
      { product: PAN, packs: 4 },
      { product: RIS, packs: 1 },
      { product: FLA, packs: 1 },
    ],
    rx: 'not_seen',
    pay: { kind: 'wallet', provider: 'raast', ref: 'RA9001', card: 30_000 },
  });
  await sell({
    items: [
      { product: BRU, packs: 1 },
      { product: CAL, packs: 1 },
    ],
    // Rs 10 off the bill ("10/-"), 3.7%.
    bill: { amount: 1_000 },
    pay: { kind: 'cash' },
  });
  await sell({ items: [{ product: SUR, packs: 2 }], pay: { kind: 'cash', tendered: 140_000 } });
  await moveCash('Cash out', 35_000, 'Tea and biscuits');

  // ---- Afternoon ----
  await sell({ items: [{ product: PAN, packs: 10 }], pay: { kind: 'card' } });
  await sell({
    items: [{ product: CAL, packs: 1 }],
    pay: { kind: 'wallet', provider: 'jazzcash', ref: 'JC200345' },
  });
  await sell({
    items: [{ product: BRU, packs: 5 }],
    pay: {
      kind: 'wallet',
      provider: 'easypaisa',
      ref: 'EP12121212',
      amount: 20_000,
      tendered: 30_000,
    },
  });
  // This one is voided later: card and cash.
  await sell({
    items: [
      { product: RIS, packs: 1 },
      { product: SUR, packs: 1 },
    ],
    bill: { percent: 2 },
    pay: { kind: 'card', card: 100_000 },
  });
  const toVoid = sales.at(-1)!;
  await sell({
    items: [
      { product: PAN, packs: 2 },
      { product: BRU, packs: 2 },
      { product: CAL, packs: 1, off: 5 },
    ],
    pay: { kind: 'cash', tendered: 50_000 },
  });
  await sell({ items: [{ product: FLA, packs: 3 }], rx: 'seen', pay: { kind: 'cash' } });
  await sell({
    items: [{ product: RIS, packs: 1, off: 15 }],
    approval: true,
    pay: { kind: 'card' },
  });

  // Rs 1,000 for an Rs 87 bill: the till asks before taking it.
  await sell({ items: [{ product: BRU, packs: 1 }], pay: { kind: 'cash', tendered: 100_000 } });

  // The customer changed their mind: void it from the Sales screen with the owner's PIN.
  await page.keyboard.press('Alt+2');
  await page.getByRole('button', { name: toVoid.invoice }).click();
  await page.getByRole('button', { name: 'Void sale' }).click();
  const detail = page.getByRole('dialog');
  await detail.getByLabel('Reason').fill('Customer changed mind');
  await detail.getByRole('button', { name: 'Void sale' }).click();
  await detail.getByLabel('Their PIN').fill(OWNER_PIN);
  await detail.getByRole('button', { name: 'Void sale' }).click();
  await expect(page.getByText(`Give back ${formatMoney(toVoid.cash)} cash`)).toBeVisible();
  await expect(
    page.getByText(`Reverse the ${formatMoney(toVoid.card)} card payment`),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.getByRole('row', { name: new RegExp(toVoid.invoice) })).toContainText('Voided');
  voided.add(toVoid.invoice);
  await page.keyboard.press('Alt+1');
  await expect(page.getByLabel('Scan or search')).toBeFocused();

  await sell({
    items: [{ product: CAL, packs: 3 }],
    pay: { kind: 'wallet', provider: 'raast', ref: 'RA9002' },
  });
  await sell({ items: [{ product: PAN, packs: 1 }], pay: { kind: 'cash' } });
  // 5% off the whole bill is the cashier's limit exactly.
  await sell({
    items: [
      { product: SUR, packs: 1 },
      { product: RIS, packs: 1 },
      { product: PAN, packs: 2 },
    ],
    bill: { percent: 5 },
    pay: { kind: 'wallet', provider: 'jazzcash', ref: 'JC300456', card: 50_000 },
  });
  await sell({ items: [{ product: BRU, packs: 2 }], pay: { kind: 'cash' } });
  await sell({
    items: [
      { product: CAL, packs: 1 },
      { product: FLA, packs: 1 },
    ],
    rx: 'seen',
    pay: { kind: 'card' },
  });
  await sell({ items: [{ product: PAN, packs: 5 }], pay: { kind: 'cash', tendered: 20_000 } });
  await sell({
    items: [{ product: RIS, packs: 3, off: 10 }],
    approval: true,
    pay: { kind: 'cash', tendered: 120_000 },
  });
  await sell({ items: [{ product: SUR, packs: 1 }], pay: { kind: 'cash' } });
  // Typed by name with a quantity: "6*panadol" is six strips.
  await sell({
    items: [{ product: PAN, packs: 6, search: 'panadol' }],
    pay: { kind: 'wallet', provider: 'easypaisa', ref: 'EP34343434' },
  });
  expect(sales).toHaveLength(31);

  // ---- What the day should add up to ----
  const kept = sales.filter((s) => !voided.has(s.invoice));
  const sum = (list: Recorded[], pick: (s: Recorded) => Money) =>
    list.reduce((acc, s) => acc + pick(s), 0);
  const day = {
    count: kept.length,
    gross: sum(kept, (s) => s.gross),
    discounts: sum(kept, (s) => s.discounts),
    rounding: sum(kept, (s) => s.rounding),
    total: sum(kept, (s) => s.total),
    cash: sum(kept, (s) => s.cash),
    card: sum(kept, (s) => s.card),
    wallet: {
      jazzcash: sum(kept, (s) => s.wallet.jazzcash ?? 0),
      easypaisa: sum(kept, (s) => s.wallet.easypaisa ?? 0),
      raast: sum(kept, (s) => s.wallet.raast ?? 0),
    },
    voidTotal: sum(
      sales.filter((s) => voided.has(s.invoice)),
      (s) => s.total,
    ),
  };
  const walletTotal = day.wallet.jazzcash + day.wallet.easypaisa + day.wallet.raast;
  // The test's own books balance before the till's are checked.
  expect(day.gross - day.discounts + day.rounding).toBe(day.total);
  expect(day.cash + day.card + walletTotal).toBe(day.total);
  const expected = float + day.cash + cashIn - cashOut;

  // ---- Close: Sana counts the drawer blind and is Rs 20 short ----
  const counted = expected - 2_000;
  await page.keyboard.press('Alt+5');
  await expect(page.getByRole('row', { name: /Expected in drawer/ })).toContainText(
    'Shown after the count',
  );
  await page.getByRole('button', { name: 'Close shift' }).click();
  const close = page.getByRole('dialog', { name: 'Close the shift' });
  let left = counted;
  for (const note of [5000, 1000, 500, 100, 50, 20, 10]) {
    const n = Math.floor(left / (note * 100));
    if (n > 0) await close.getByLabel(`Rs ${note.toLocaleString('en-US')} ×`).fill(String(n));
    left -= n * note * 100;
  }
  if (left > 0) await close.getByLabel('Coins').fill(typed(left));
  await expect(close.getByText(`Total: ${formatMoney(counted)}`)).toBeVisible();
  await close.getByRole('button', { name: 'Close shift' }).click();
  await expect(page.getByRole('heading', { name: 'Shift 1 closed' })).toBeVisible();

  // ---- The Z report equals the test's sums ----
  const report: [string, string][] = [
    ['Sales', String(day.count)],
    ['Items total', formatMoney(day.gross)],
    ['Discounts', formatMoney(-day.discounts)],
    ['Rounding', formatMoney(day.rounding)],
    ['Sales total', formatMoney(day.total)],
    ['Tax included', formatMoney(0)],
    ['Voided', `1 · ${formatMoney(day.voidTotal)}`],
    ['Returns', `0 · ${formatMoney(0)}`],
    ['Opening float', formatMoney(float)],
    ['Cash', formatMoney(day.cash)],
    ['Cash in', formatMoney(cashIn)],
    ['Cash out', formatMoney(-cashOut)],
    ['Expected in drawer', formatMoney(expected)],
    ['Cash counted', formatMoney(counted)],
    ['Difference', formatMoney(counted - expected)],
    ['Card', formatMoney(day.card)],
    ['Wallets', formatMoney(walletTotal)],
    ['JazzCash', formatMoney(day.wallet.jazzcash)],
    ['Easypaisa', formatMoney(day.wallet.easypaisa)],
    ['Raast', formatMoney(day.wallet.raast)],
    ['Lines sold above MRP', '0'],
    ['Lines sold without recorded stock', '0'],
    ['Prescriptions not seen', String(rxNotSeen)],
    ['Held sales', '0'],
  ];
  const seen: [string, string][] = [];
  for (const [label] of report) {
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: label, exact: true }) });
    seen.push([label, (await row.getByRole('cell').innerText()).trim()]);
  }
  expect(seen).toEqual(report);

  // ---- The records check (checkRecords) finds nothing ----
  // The preview has no screen for it yet (the Health screen comes in M5), so open the same
  // browser database a second time through the dev server and run it read-only.
  const records = await page.evaluate(`(async () => {
    const { createBrowserExecutor } = await import('/src/platform/browser-executor.ts');
    const { createKysely, checkRecords } = await import('/@id/@app/db');
    const db = createKysely(await createBrowserExecutor());
    const sales = await db.selectFrom('sale').select('id').execute();
    return { sales: sales.length, problems: await checkRecords(db) };
  })()`);
  // It sees the day (all 31 sales, the voided one included), and nothing is out of line.
  expect(records).toEqual({ sales: 31, problems: [] });

  expect(problems).toEqual([]);
});
