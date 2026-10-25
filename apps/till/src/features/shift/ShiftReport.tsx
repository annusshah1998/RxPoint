import { formatMoney, type Money } from '@app/core';
import type { ShiftTotals } from '@app/db';
import { S } from '../../strings';

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <tr className={strong ? 'report-strong' : ''}>
      <th scope="row">{label}</th>
      <td>{value}</td>
    </tr>
  );
}

const m = (v: Money) => formatMoney(v);

/** The X report (shift so far) or Z report (closed shift), from the records. */
export function ShiftReport({ totals }: { totals: ShiftTotals }) {
  const { sales, payments, shift } = totals;
  const wallets = Object.entries(totals.walletByProvider);
  return (
    <div className="report-columns">
      <table className="report-table">
        <tbody>
          <Row label={S.shift.salesCount} value={String(sales.count)} />
          <Row label={S.shift.gross} value={m(sales.gross)} />
          <Row label={S.shift.discounts} value={m(-sales.discounts)} />
          <Row label={S.shift.rounding} value={m(sales.rounding)} />
          <Row label={S.shift.salesTotal} value={m(sales.total)} strong />
          <Row label={S.shift.tax} value={m(sales.tax)} />
          <Row label={S.shift.voids} value={`${totals.voids.count} · ${m(totals.voids.total)}`} />
          <Row
            label={S.shift.returns}
            value={`${totals.returns.count} · ${m(totals.returns.total)}`}
          />
        </tbody>
      </table>
      <table className="report-table">
        <tbody>
          <Row label={S.shift.float} value={m(shift.openingFloat)} />
          <Row label={S.shift.cash} value={m(payments.cash.net)} />
          <Row label={S.shift.cashIn} value={m(totals.cashIn)} />
          <Row label={S.shift.cashOut} value={m(-totals.cashOut)} />
          <Row
            label={S.shift.expected}
            value={totals.expectedCash === null ? S.shift.blind : m(totals.expectedCash)}
            strong
          />
          {shift.countedCash !== null && (
            <Row label={S.shift.counted} value={m(shift.countedCash)} />
          )}
          {shift.variance !== null && <Row label={S.shift.variance} value={m(shift.variance)} />}
          <Row label={S.shift.card} value={m(payments.card.net)} />
          <Row label={S.shift.wallet} value={m(payments.wallet.net)} />
          {wallets.map(([provider, amount]) => (
            <Row key={provider} label={`  ${provider}`} value={m(amount)} />
          ))}
        </tbody>
      </table>
      <table className="report-table">
        <tbody>
          <Row label={S.shift.aboveMrp} value={String(totals.flags.aboveMrp)} />
          <Row label={S.shift.unrecorded} value={String(totals.flags.unrecorded)} />
          <Row label={S.shift.rxNotSeen} value={String(totals.flags.rxNotSeen)} />
          <Row label={S.shift.held} value={String(totals.heldSales)} />
          {totals.clockBehind && <Row label={S.shift.clockBehind} value={S.common.yes} />}
        </tbody>
      </table>
    </div>
  );
}
