import { PKR_NOTES, formatMoney, parseMoney, type CashCount } from '@app/core';
import { S } from '../../strings';
import { Field, TextInput } from '../../ui';

export interface CountState {
  notes: Record<string, string>;
  coins: string;
}

export const emptyCount = (): CountState => ({ notes: {}, coins: '' });

/** The count as the service wants it, or null if something typed isn't a number. */
export function toCashCount(state: CountState): CashCount | null {
  const notes: Record<string, number> = {};
  for (const note of PKR_NOTES) {
    const text = state.notes[String(note)]?.trim() ?? '';
    if (!text) continue;
    if (!/^\d+$/.test(text)) return null;
    notes[String(note)] = Number(text);
  }
  const coins = state.coins.trim() ? parseMoney(state.coins) : 0;
  return coins === null ? null : { notes, coins };
}

export function countSum(count: CashCount | null): number | null {
  if (!count) return null;
  return Object.entries(count.notes).reduce((s, [v, n]) => s + Number(v) * (n ?? 0), count.coins);
}

/** One box per note value, then coins, with the running total. */
export function CashCountFields({
  value,
  onChange,
}: {
  value: CountState;
  onChange: (value: CountState) => void;
}) {
  const total = countSum(toCashCount(value));
  return (
    <div className="cash-count">
      <div className="cash-count-grid">
        {PKR_NOTES.map((note) => (
          <Field key={note} label={`${formatMoney(note).replace('.00', '')} ×`}>
            <TextInput
              inputMode="numeric"
              value={value.notes[String(note)] ?? ''}
              onChange={(e) =>
                onChange({ ...value, notes: { ...value.notes, [String(note)]: e.target.value } })
              }
            />
          </Field>
        ))}
        <Field label={S.shift.coins}>
          <TextInput
            inputMode="decimal"
            value={value.coins}
            onChange={(e) => onChange({ ...value, coins: e.target.value })}
          />
        </Field>
      </div>
      <div className="cash-count-total">
        {S.shift.countTotal}: <strong>{total === null ? '—' : formatMoney(total)}</strong>
      </div>
    </div>
  );
}
