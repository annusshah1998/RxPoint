import { getDeviceSettings, updateDeviceSettings, type DeviceSettings } from '@app/db';
import type { ReceiptDocument } from '@app/receipt';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useAction, useServices } from '../../app/services';
import { errorMessage, fieldErrors } from '../../lib/errors';
import type { PrinterSettings } from '../../platform/printer';
import { S } from '../../strings';
import { Button, Card, Checkbox, Field, Loading, Modal, Notice, Select, TextInput } from '../../ui';
import { PrintStatus } from '../printing/PrintStatus';
import { usePrinting } from '../printing/printing';
import { ReceiptPreview } from '../receipt/ReceiptPreview';
import { testPage } from '../receipt/test-page';

/** Settings → This till's printer (§5.11): saved on this computer only (device settings). */
export function PrinterSettingsCard() {
  const { ctx } = useServices();
  const device = useQuery({ queryKey: ['device-settings'], queryFn: () => getDeviceSettings(ctx) });
  return (
    <Card title={S.printerSettings.title}>
      {device.data ? <PrinterForm initial={device.data} /> : <Loading />}
    </Card>
  );
}

type Mode = DeviceSettings['printer']['mode'];

function PrinterForm({ initial }: { initial: DeviceSettings }) {
  const { platform, printer: port, store } = useServices();
  const printing = usePrinting();
  const [v, setV] = useState({
    mode: initial.printer.mode,
    printerName: initial.printer.printerName ?? '',
    host: initial.printer.host,
    port: String(initial.printer.port),
    columns: String(initial.printer.columns),
    cut: initial.printer.cut,
    autoPrint: initial.printer.autoPrint,
    drawer: initial.drawer.enabled,
    pin: String(initial.drawer.pin),
  });
  const [portError, setPortError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [testJob, setTestJob] = useState<number | null>(null);
  const [drawerJob, setDrawerJob] = useState<number | null>(null);
  const [preview, setPreview] = useState<ReceiptDocument | null>(null);
  const [testDoc, setTestDoc] = useState<ReceiptDocument | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const save = useAction(updateDeviceSettings, { onSuccess: () => setSaved(true) });
  const printers = useQuery({
    queryKey: ['printers'],
    queryFn: () => port.listPrinters(),
    enabled: v.mode === 'windows',
  });
  const errors = fieldErrors(save.error);

  const change = (patch: Partial<typeof v>) => {
    setSaved(false);
    setV((s) => ({ ...s, ...patch }));
  };

  /** The settings as on screen, so a test uses them before they are saved. */
  function current(): PrinterSettings | null {
    const portNo = Number(v.port.trim());
    if (!Number.isInteger(portNo) || portNo < 1 || portNo > 65_535) {
      setPortError(S.printerSettings.badPort);
      return null;
    }
    setPortError(undefined);
    return {
      printer: {
        mode: v.mode,
        printerName: v.printerName || null,
        host: v.host.trim(),
        port: portNo,
        columns: Number(v.columns) as 48 | 42 | 32,
        cut: v.cut,
        autoPrint: v.autoPrint,
      },
      drawer: { enabled: v.drawer, pin: Number(v.pin) as 2 | 5 },
    };
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const settings = current();
    if (settings) save.mutate(settings);
  }

  function printTestPage() {
    const settings = current();
    if (!settings) return;
    const doc = testPage(settings, store.branchName);
    setTestError(null);
    if (settings.printer.mode === 'off') {
      // Nothing to print on: show what the page looks like.
      setPreview(doc);
      return;
    }
    setPreview(null);
    setTestJob(printing.printTest(doc, settings));
    setTestDoc(doc);
  }

  async function testDrawer() {
    const settings = current();
    if (!settings) return;
    setTestError(null);
    try {
      setDrawerJob(await printing.testDrawer(settings));
    } catch (err) {
      setTestError(err);
    }
  }

  const printerOff = v.mode === 'off';
  const otherPrinters = printers.data ?? [];
  return (
    <form onSubmit={submit} noValidate>
      <p className="muted">{S.printerSettings.intro}</p>
      {platform === 'browser' && <Notice tone="info">{S.printerSettings.browser}</Notice>}
      {save.isError && Object.keys(errors).length === 0 && (
        <Notice tone="bad">{errorMessage(save.error)}</Notice>
      )}
      <div className="row">
        <Field label={S.printerSettings.mode}>
          <Select value={v.mode} onChange={(e) => change({ mode: e.target.value as Mode })}>
            {(['off', 'windows', 'network'] as const).map((m) => (
              <option key={m} value={m}>
                {S.printerSettings.modes[m]}
              </option>
            ))}
          </Select>
        </Field>
        {v.mode === 'windows' && (
          <Field
            label={S.printerSettings.printerName}
            hint={
              printers.isSuccess && otherPrinters.length === 0
                ? S.printerSettings.noPrinters
                : undefined
            }
          >
            <Select value={v.printerName} onChange={(e) => change({ printerName: e.target.value })}>
              <option value="">{S.printerSettings.windowsDefault}</option>
              {otherPrinters.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
              {/* A saved printer that isn't installed now stays selectable. */}
              {v.printerName && !otherPrinters.some((p) => p.name === v.printerName) && (
                <option value={v.printerName}>{v.printerName}</option>
              )}
            </Select>
          </Field>
        )}
        {v.mode === 'network' && (
          <>
            <Field
              label={S.printerSettings.host}
              hint={S.printerSettings.hostHint}
              error={errors['printer.host']}
            >
              <TextInput value={v.host} onChange={(e) => change({ host: e.target.value })} />
            </Field>
            <Field
              label={S.printerSettings.port}
              hint={S.printerSettings.portHint}
              error={portError ?? errors['printer.port']}
            >
              <TextInput
                value={v.port}
                inputMode="numeric"
                onChange={(e) => change({ port: e.target.value })}
              />
            </Field>
          </>
        )}
        <Field label={S.printerSettings.columns} hint={S.printerSettings.columnsHint}>
          <Select value={v.columns} onChange={(e) => change({ columns: e.target.value })}>
            {Object.entries(S.printerSettings.columnOptions).map(([n, label]) => (
              <option key={n} value={n}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="checkbox-row">
        <Checkbox
          label={S.printerSettings.cut}
          checked={v.cut}
          onChange={(cut) => change({ cut })}
        />
      </div>
      <div className="checkbox-row">
        <Checkbox
          label={S.printerSettings.autoPrint}
          checked={v.autoPrint}
          onChange={(autoPrint) => change({ autoPrint })}
        />
        <div className="field-hint">{S.printerSettings.autoPrintHint}</div>
      </div>
      <h3 className="form-section">{S.printer.drawerTitle}</h3>
      <div className="checkbox-row">
        <Checkbox
          label={S.printerSettings.drawer}
          checked={v.drawer}
          onChange={(drawer) => change({ drawer })}
        />
        <div className="field-hint">{S.printerSettings.drawerHint}</div>
      </div>
      <div className="row">
        <Field
          label={S.printerSettings.pin}
          hint={S.printerSettings.pinHint}
          className="field-short"
        >
          <Select value={v.pin} onChange={(e) => change({ pin: e.target.value })}>
            {Object.entries(S.printerSettings.pins).map(([pin, label]) => (
              <option key={pin} value={pin}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {S.settings.save}
        </Button>
        <Button onClick={printTestPage}>{S.printerSettings.testPage}</Button>
        <Button
          onClick={() => void testDrawer()}
          disabled={printerOff}
          title={printerOff ? S.printerSettings.needsPrinter : undefined}
        >
          {S.printerSettings.testDrawer}
        </Button>
        {saved && <span className="muted">{S.settings.saved}</span>}
      </div>
      {printerOff && <p className="muted">{S.printerSettings.needsPrinter}</p>}
      {testError != null && <Notice tone="bad">{errorMessage(testError)}</Notice>}
      {testJob !== null && <PrintStatus jobId={testJob} onShow={() => setPreview(testDoc)} />}
      {drawerJob !== null && <PrintStatus jobId={drawerJob} />}
      {preview && (
        <Modal title={S.printer.testTitle} onClose={() => setPreview(null)}>
          <ReceiptPreview doc={preview} />
        </Modal>
      )}
    </form>
  );
}
