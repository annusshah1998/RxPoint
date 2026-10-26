import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { S } from '../strings';

// Section 2 of the user guide, without the bold marks.
const guide = readFileSync(
  new URL('../../../../docs/user-guide/README.md', import.meta.url),
  'utf8',
);
const shortcuts = guide
  .slice(guide.indexOf('## 2. Keyboard shortcuts'), guide.indexOf('## 3. '))
  .replaceAll('**', '');

describe('the F1 list of keys', () => {
  it('is in step with the user guide', () => {
    expect(shortcuts.length).toBeGreaterThan(0);
    const keys = [
      ...S.help.anywhereKeys.map(([key]) => key),
      ...S.help.groups.flatMap((g) => g.rows.map(([key]) => key)),
      ...['1', '2', '3', '4', '5', '9'].map(S.nav.key),
    ];
    for (const key of keys) expect(shortcuts, key).toContain(key);
  });
});
