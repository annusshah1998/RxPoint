import { useEffect, useState } from 'react';
import { S } from '../strings';
import { Modal } from '../ui';

/**
 * The F1 list of keys (§5.4). `screens` are the Alt+digit screens this person may open.
 * Closing it puts the cursor back where it was, so F1 in the middle of Pay costs nothing.
 */
export function HelpDialog({
  screens,
  onClose,
}: {
  screens: { key: string; label: string }[];
  onClose: () => void;
}) {
  const [before] = useState(() => document.activeElement);
  useEffect(
    () => () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    },
    [before],
  );

  const groups = [
    {
      title: S.help.anywhere,
      rows: [
        ...S.help.anywhereKeys,
        ...screens
          .toSorted((a, b) => a.key.localeCompare(b.key))
          .map((s) => [S.nav.key(s.key), S.help.goTo(s.label)] as const),
      ],
    },
    ...S.help.groups,
  ];
  return (
    <Modal title={S.help.title} onClose={onClose}>
      <p className="muted">{S.help.intro}</p>
      {groups.map((group) => (
        <section key={group.title} className="help-group">
          <h3>{group.title}</h3>
          <table className="table table-compact help-table">
            <tbody>
              {group.rows.map(([key, what]) => (
                <tr key={key}>
                  <th scope="row">
                    <kbd>{key}</kbd>
                  </th>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </Modal>
  );
}
