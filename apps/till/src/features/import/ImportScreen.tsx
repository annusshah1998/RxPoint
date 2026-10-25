import { AppError, formatQty } from '@app/core';
import {
  IMPORT_FIELDS,
  IMPORT_FIELD_KEYS,
  IMPORT_TEMPLATE_CSV,
  guessMapping,
  parseCsv,
  planImport,
  runImport,
  type ImportMapping,
  type ImportPlan,
  type ImportResult,
  type ParsedCsv,
} from '@app/db';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useRoute } from '../../app/router';
import { useServices } from '../../app/services';
import { errorMessage } from '../../lib/errors';
import { S } from '../../strings';
import { Badge, Button, Card, Checkbox, Notice, PageHeader, Select } from '../../ui';

const SAMPLE_FILE = 'sample-stock.csv';

type Step =
  | { name: 'choose' }
  | { name: 'map'; fileName: string; csv: ParsedCsv; mapping: ImportMapping }
  | { name: 'review'; fileName: string; csv: ParsedCsv; mapping: ImportMapping; plan: ImportPlan }
  | { name: 'running'; done: number; total: number }
  | { name: 'done'; result: ImportResult };

export function ImportScreen() {
  const { ctx } = useServices();
  const { navigate } = useRoute();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ name: 'choose' });
  const [error, setError] = useState<unknown>(null);

  async function chooseFile(file: File) {
    setError(null);
    try {
      const csv = parseCsv(await file.text());
      if (csv.rows.length === 0) {
        setError(new AppError('VALIDATION', S.import.noRows));
        return;
      }
      setStep({ name: 'map', fileName: file.name, csv, mapping: guessMapping(csv.headers) });
    } catch (err) {
      setError(err);
    }
  }

  /** Development only: the sample stock list in samples/, straight to the review step. */
  async function loadSample() {
    setError(null);
    try {
      const { default: text } = await import('../../../../../samples/sample-stock.csv?raw');
      const csv = parseCsv(text);
      await check(SAMPLE_FILE, csv, guessMapping(csv.headers));
    } catch (err) {
      setError(err);
    }
  }

  async function check(fileName: string, csv: ParsedCsv, mapping: ImportMapping) {
    setError(null);
    try {
      setStep({
        name: 'review',
        fileName,
        csv,
        mapping,
        plan: await planImport(ctx, csv, mapping),
      });
    } catch (err) {
      setError(err);
    }
  }

  async function run(plan: ImportPlan) {
    setError(null);
    const total = plan.rows.filter((r) => r.status !== 'error').length;
    setStep({ name: 'running', done: 0, total });
    try {
      const result = await runImport(ctx, plan, (done) =>
        setStep({ name: 'running', done, total }),
      );
      await queryClient.invalidateQueries();
      setStep({ name: 'done', result });
    } catch (err) {
      setError(err);
      setStep({ name: 'choose' });
    }
  }

  return (
    <div className="page">
      <PageHeader title={S.import.title} subtitle={S.import.intro} />
      {error != null && <Notice tone="bad">{errorMessage(error)}</Notice>}

      {step.name === 'choose' && (
        <ChooseFile onFile={chooseFile} onSample={import.meta.env.DEV ? loadSample : null} />
      )}

      {step.name === 'map' && (
        <MapColumns
          csv={step.csv}
          fileName={step.fileName}
          mapping={step.mapping}
          onChange={(mapping) => setStep({ ...step, mapping })}
          onBack={() => setStep({ name: 'choose' })}
          onNext={() => check(step.fileName, step.csv, step.mapping)}
        />
      )}

      {step.name === 'review' && (
        <Review
          plan={step.plan}
          onBack={() =>
            setStep({ name: 'map', fileName: step.fileName, csv: step.csv, mapping: step.mapping })
          }
          onRun={() => run(step.plan)}
        />
      )}

      {step.name === 'running' && (
        <Card>
          <p role="status">{S.import.running(step.done, step.total)}</p>
          <progress max={step.total} value={step.done} />
        </Card>
      )}

      {step.name === 'done' && (
        <Card title={S.import.done}>
          <p role="status">
            {S.import.result({
              productsCreated: step.result.productsCreated,
              stockLinesAdded: step.result.stockLinesAdded,
              failed: step.result.failed.length,
            })}
          </p>
          {step.result.failed.length > 0 && (
            <ul className="problem-list">
              {step.result.failed.map((f) => (
                <li key={f.rowNumber}>
                  {S.import.row} {f.rowNumber}: {f.error}
                </li>
              ))}
            </ul>
          )}
          <div className="form-actions">
            <Button variant="primary" onClick={() => navigate({ name: 'products' })}>
              {S.import.viewProducts}
            </Button>
            <Button onClick={() => setStep({ name: 'choose' })}>{S.import.another}</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function ChooseFile({
  onFile,
  onSample,
}: {
  onFile: (file: File) => void;
  /** Loads the sample stock list (development builds only). */
  onSample: (() => void) | null;
}) {
  const templateUrl = useMemo(
    () => URL.createObjectURL(new Blob([IMPORT_TEMPLATE_CSV], { type: 'text/csv' })),
    [],
  );
  return (
    <Card title={S.import.step1}>
      <div className="form-actions">
        <label className="btn btn-primary btn-normal file-button">
          {S.import.chooseFile}
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onFile(file);
              e.target.value = '';
            }}
          />
        </label>
        <a
          className="btn btn-secondary btn-normal"
          href={templateUrl}
          download="product-import-template.csv"
        >
          {S.import.template}
        </a>
        {onSample && <Button onClick={onSample}>{S.import.loadSample}</Button>}
      </div>
      {onSample && <p className="muted">{S.import.sampleHint}</p>}
    </Card>
  );
}

function MapColumns({
  csv,
  fileName,
  mapping,
  onChange,
  onBack,
  onNext,
}: {
  csv: ParsedCsv;
  fileName: string;
  mapping: ImportMapping;
  onChange: (mapping: ImportMapping) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const first = csv.rows[0] ?? [];
  return (
    <Card title={`${S.import.step2} — ${fileName}`}>
      <table className="table table-compact">
        <thead>
          <tr>
            <th>{S.import.field}</th>
            <th>{S.import.column}</th>
            <th>{S.import.sample}</th>
          </tr>
        </thead>
        <tbody>
          {IMPORT_FIELD_KEYS.map((field) => {
            const index = mapping[field];
            return (
              <tr key={field}>
                <td>
                  {IMPORT_FIELDS[field].label}
                  {field === 'name' && <span className="muted"> ({S.import.required})</span>}
                </td>
                <td>
                  <Select
                    aria-label={IMPORT_FIELDS[field].label}
                    value={index === undefined ? '' : String(index)}
                    onChange={(e) => {
                      const next = { ...mapping };
                      if (e.target.value === '') delete next[field];
                      else next[field] = Number(e.target.value);
                      onChange(next);
                    }}
                  >
                    <option value="">{S.import.notImported}</option>
                    {csv.headers.map((header, i) => (
                      <option key={i} value={String(i)}>
                        {header || S.import.columnN(i + 1)}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="muted">{index === undefined ? '' : (first[index] ?? '')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {mapping.name === undefined && <Notice tone="warn">{S.import.nameRequired}</Notice>}
      <div className="form-actions">
        <Button variant="primary" disabled={mapping.name === undefined} onClick={onNext}>
          {S.import.check}
        </Button>
        <Button onClick={onBack}>{S.common.back}</Button>
      </div>
    </Card>
  );
}

function Review({
  plan,
  onBack,
  onRun,
}: {
  plan: ImportPlan;
  onBack: () => void;
  onRun: () => void;
}) {
  const [onlyProblems, setOnlyProblems] = useState(plan.counts.errors > 0);
  const importable = plan.rows.filter((r) => r.status !== 'error').length;
  const rows = onlyProblems
    ? plan.rows.filter((r) => r.errors.length > 0 || r.warnings.length > 0)
    : plan.rows;
  return (
    <Card title={S.import.step3}>
      <p role="status">{S.import.summary(plan.counts)}</p>
      {plan.counts.existingProducts > 0 && <p className="muted">{S.import.existingNote}</p>}
      <Checkbox label={S.import.onlyProblems} checked={onlyProblems} onChange={setOnlyProblems} />
      <div className="table-scroll">
        <table className="table table-compact">
          <thead>
            <tr>
              <th className="num">{S.import.row}</th>
              <th>{S.import.name}</th>
              <th>{S.import.status}</th>
              <th>{S.import.stockCol}</th>
              <th>{S.import.problems}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.rowNumber}>
                <td className="num">{row.rowNumber}</td>
                <td>{row.name || <span className="muted">{S.common.none}</span>}</td>
                <td>
                  {row.status === 'error' ? (
                    <Badge tone="bad">{S.import.statuses.error}</Badge>
                  ) : row.repeatOf ? (
                    <Badge>
                      {S.import.statuses.repeat} {row.repeatOf}
                    </Badge>
                  ) : row.status === 'existing' ? (
                    <Badge tone="info">{S.import.statuses.existing}</Badge>
                  ) : (
                    <Badge tone="good">{S.import.statuses.new}</Badge>
                  )}
                </td>
                <td>
                  {row.stock && row.product
                    ? formatQty(row.stock.qty, row.product.units)
                    : row.stock
                      ? row.stock.qty
                      : ''}
                </td>
                <td>
                  {row.errors.map((e) => (
                    <div key={e} className="text-bad">
                      {e}
                    </div>
                  ))}
                  {row.warnings.map((w) => (
                    <div key={w} className="muted">
                      {w}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-actions">
        <Button variant="primary" disabled={importable === 0} onClick={onRun}>
          {S.import.run(importable)}
        </Button>
        <Button onClick={onBack}>{S.common.back}</Button>
      </div>
    </Card>
  );
}
