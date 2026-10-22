import { sql, type RawBuilder } from 'kysely';
import type { Db } from '../executor';
import { META, getMeta } from '../meta';
import { SYNCED_TABLES } from '../writes';
import { expectedCashTx } from './guards';
import { findStockCacheMismatches } from './stock';

export interface RecordProblem {
  check: string;
  id: string;
  detail: string;
}

/**
 * Checks that the records add up. Should always return nothing; anything it finds is a
 * bug (or tampering). Used by the tests now and by the Health screen later.
 */
export async function checkRecords(db: Db): Promise<RecordProblem[]> {
  const problems: RecordProblem[] = [];
  const add = (check: string, rows: { id: string; detail?: string | null }[]) => {
    for (const r of rows) problems.push({ check, id: r.id, detail: r.detail ?? '' });
  };
  const rows = async <T>(query: RawBuilder<T>) => (await query.execute(db)).rows;

  // Stock on hand matches the ledger.
  for (const m of await findStockCacheMismatches(db)) {
    problems.push({
      check: 'stock_cache',
      id: m.batchId,
      detail: `cached ${m.cached}, ledger ${m.ledger}`,
    });
  }

  // A sale's header is the sum of its lines.
  add(
    'sale_header',
    await rows<{ id: string; detail: string }>(sql`
      SELECT s.id, 'header ' || s.subtotal || ' lines ' || COALESCE(SUM(l.net), 0) AS detail
      FROM sale s LEFT JOIN sale_line l ON l.sale_id = s.id
      GROUP BY s.id
      HAVING s.line_count != COUNT(l.id)
          OR s.gross_total != COALESCE(SUM(l.gross), 0)
          OR s.line_discount_total != COALESCE(SUM(l.line_discount), 0)
          OR s.bill_discount != COALESCE(SUM(l.bill_discount_share), 0)
          OR s.subtotal != COALESCE(SUM(l.net), 0)
          OR s.tax_total != COALESCE(SUM(l.tax), 0)
    `),
  );

  // What was paid for a sale is its total (a zero bill has no payments).
  add(
    'sale_payments',
    await rows<{ id: string; detail: string }>(sql`
      SELECT s.id, 'total ' || s.total || ' paid ' || COALESCE(SUM(p.amount), 0) AS detail
      FROM sale s LEFT JOIN payment p ON p.sale_id = s.id AND p.doc_type = 'sale'
      GROUP BY s.id
      HAVING s.total != COALESCE(SUM(p.amount), 0)
    `),
  );

  // Each line's batches add up to its quantity.
  add(
    'line_allocations',
    await rows<{ id: string; detail: string }>(sql`
      SELECT l.id, 'qty ' || l.qty || ' allocated ' || COALESCE(SUM(a.qty), 0) AS detail
      FROM sale_line l LEFT JOIN sale_line_batch a ON a.sale_line_id = l.id
      GROUP BY l.id
      HAVING l.qty != COALESCE(SUM(a.qty), 0)
    `),
  );

  // Each allocation's stock movement matches it.
  add(
    'allocation_movement',
    await rows<{ id: string; detail: string }>(sql`
      SELECT a.id, 'movement ' || COALESCE(m.id, 'missing') AS detail
      FROM sale_line_batch a LEFT JOIN stock_movement m ON m.id = a.movement_id
      WHERE m.id IS NULL OR m.batch_id != a.batch_id OR m.qty != -a.qty OR m.kind != 'sale'
         OR m.ref_type != 'sale' OR m.ref_id != a.sale_id
    `),
  );

  // A void pays back exactly what was paid, method by method.
  add(
    'void_payments',
    await rows<{ id: string; detail: string }>(sql`
      SELECT v.id, p.method AS detail
      FROM sale_void v JOIN payment p ON p.sale_id = v.sale_id
      GROUP BY v.id, p.method
      HAVING SUM(CASE WHEN p.doc_type = 'sale' THEN p.amount ELSE 0 END)
          != -SUM(CASE WHEN p.doc_type = 'void' THEN p.amount ELSE 0 END)
    `),
  );

  // A void puts back exactly the stock that was taken, batch by batch.
  add(
    'void_stock',
    await rows<{ id: string; detail: string }>(sql`
      WITH taken AS (
        SELECT v.id AS void_id, a.batch_id, SUM(a.qty) AS qty
        FROM sale_void v JOIN sale_line_batch a ON a.sale_id = v.sale_id
        GROUP BY v.id, a.batch_id
      ), returned AS (
        SELECT ref_id AS void_id, batch_id, SUM(qty) AS qty
        FROM stock_movement WHERE ref_type = 'sale_void'
        GROUP BY ref_id, batch_id
      )
      SELECT t.void_id AS id, t.batch_id AS detail
      FROM taken t LEFT JOIN returned r ON r.void_id = t.void_id AND r.batch_id = t.batch_id
      WHERE COALESCE(r.qty, 0) != t.qty
    `),
  );

  // Returns add up and are paid back exactly; restocked lines have their movement.
  add(
    'return_lines',
    await rows<{ id: string; detail: string }>(sql`
      SELECT r.id, 'refund ' || r.refund_net || ' lines ' || COALESCE(SUM(l.refund), 0) AS detail
      FROM sale_return r LEFT JOIN sale_return_line l ON l.return_id = r.id
      GROUP BY r.id
      HAVING r.refund_net != COALESCE(SUM(l.refund), 0) OR r.tax_total != COALESCE(SUM(l.tax), 0)
    `),
  );
  add(
    'return_payments',
    await rows<{ id: string; detail: string }>(sql`
      SELECT r.id, 'refund ' || r.refund_total || ' paid ' || COALESCE(SUM(p.amount), 0) AS detail
      FROM sale_return r LEFT JOIN payment p ON p.doc_id = r.id AND p.doc_type = 'return'
      GROUP BY r.id
      HAVING r.refund_total != -COALESCE(SUM(p.amount), 0)
    `),
  );
  add(
    'return_restock',
    await rows<{ id: string }>(sql`
      SELECT l.id FROM sale_return_line l LEFT JOIN stock_movement m ON m.id = l.movement_id
      WHERE l.restock = 1 AND (m.id IS NULL OR m.qty != l.qty OR m.batch_id != l.batch_id)
    `),
  );
  add(
    'refunds_over_total',
    await rows<{ id: string; detail: string }>(sql`
      SELECT s.id, 'total ' || s.total || ' refunded ' || SUM(r.refund_total) AS detail
      FROM sale s JOIN sale_return r ON r.sale_id = s.id
      GROUP BY s.id HAVING SUM(r.refund_total) > s.total
    `),
  );

  // Nothing lands in a shift after it closed.
  for (const table of ['sale', 'sale_void', 'sale_return', 'payment', 'cash_movement'] as const) {
    add(
      'after_close',
      await rows<{ id: string; detail: string }>(sql`
        SELECT d.id, ${table} AS detail FROM ${sql.table(table)} d JOIN shift s ON s.id = d.shift_id
        WHERE s.status = 'closed' AND d.created_at > s.closed_at
      `),
    );
  }

  // A closed shift's expected cash is what the records say.
  const closed = await db
    .selectFrom('shift')
    .select(['id', 'expected_cash'])
    .where('status', '=', 'closed')
    .execute();
  for (const shift of closed) {
    const expected = await expectedCashTx(db, shift.id);
    if (expected !== shift.expected_cash) {
      problems.push({
        check: 'shift_expected',
        id: shift.id,
        detail: `stored ${shift.expected_cash}, records ${expected}`,
      });
    }
  }

  // Invoice numbers have no gaps, except a jump up to the floor set after a restore.
  const floor = Number((await getMeta(db, META.invoiceFloor)) ?? 0);
  const seqs = await db
    .selectFrom('sale')
    .select(['id', 'device_id', 'invoice_seq'])
    .orderBy('device_id')
    .orderBy('invoice_seq')
    .execute();
  for (let i = 1; i < seqs.length; i++) {
    const a = seqs[i - 1]!;
    const b = seqs[i]!;
    if (
      a.device_id === b.device_id &&
      b.invoice_seq !== a.invoice_seq + 1 &&
      b.invoice_seq !== floor
    ) {
      problems.push({
        check: 'invoice_gap',
        id: b.id,
        detail: `${a.invoice_seq} → ${b.invoice_seq}`,
      });
    }
  }

  // Every synced row was queued for upload when it was written.
  for (const table of Object.keys(SYNCED_TABLES)) {
    add(
      'outbox_missing',
      await rows<{ id: string; detail: string }>(sql`
        SELECT t.id, ${table} AS detail FROM ${sql.table(table)} t
        WHERE NOT EXISTS (
          SELECT 1 FROM sync_outbox o
          WHERE o.table_name = ${table} AND o.row_id = t.id AND o.op = 'insert'
        )
      `),
    );
  }

  return problems;
}
