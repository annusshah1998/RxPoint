import { renderText, type ReceiptDocument } from '@app/receipt';

/** The receipt exactly as the printer lays it out (monospace, one line per printed line). */
export function ReceiptPreview({ doc }: { doc: ReceiptDocument }) {
  return (
    <pre
      className="receipt-preview"
      data-testid="receipt-preview"
      style={{ width: `${doc.width + 2}ch` }}
    >
      {renderText(doc)
        .map((l) => l.trimEnd())
        .join('\n')}
    </pre>
  );
}
