import { checkBackupFolder, getDeviceSettings, updateDeviceSettings } from '@app/db';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useAction, useServices } from '../../app/services';
import { errorMessage, fieldErrors } from '../../lib/errors';
import { S } from '../../strings';
import { Button, Card, Field, Loading, Notice, TextInput } from '../../ui';

/**
 * Settings → Backups (§5.11): the mirror folder, a USB stick or a second drive that gets
 * a copy of every backup. Saved on this computer only (device settings).
 */
export function BackupSettingsCard() {
  const { ctx } = useServices();
  const device = useQuery({ queryKey: ['device-settings'], queryFn: () => getDeviceSettings(ctx) });
  return (
    <Card title={S.backupSettings.title}>
      {device.data ? <MirrorForm initial={device.data.backup.mirrorDir ?? ''} /> : <Loading />}
    </Card>
  );
}

type TestResult = { ok: true; dir: string } | { ok: false; error: unknown };

function MirrorForm({ initial }: { initial: string }) {
  const { ctx, backupPort } = useServices();
  const [dir, setDir] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  async function testFolder(path: string) {
    if (!backupPort) return;
    setTesting(true);
    setTest(null);
    try {
      await checkBackupFolder(ctx, backupPort, path);
      setTest({ ok: true, dir: path.trim() });
    } catch (error) {
      setTest({ ok: false, error });
    } finally {
      setTesting(false);
    }
  }

  // Saving a folder also tests it (and creates it on a stick that is plugged in), so the
  // first backup after this doesn't fail for a folder that isn't there yet.
  const save = useAction(updateDeviceSettings, {
    onSuccess: (after) => {
      setSaved(true);
      if (after.backup.mirrorDir) void testFolder(after.backup.mirrorDir);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setTest(null);
    save.mutate({ backup: { mirrorDir: dir.trim() || null } });
  }

  // Folder problems go on the field; anything else above the form.
  const testError = test && !test.ok ? test.error : null;
  const saveField = fieldErrors(save.error)['backup.mirrorDir'];
  const testField = fieldErrors(testError)['backup.mirrorDir'];
  const fieldError = saveField ?? testField;
  const otherError: unknown =
    save.isError && !saveField ? save.error : testError && !testField ? testError : null;

  return (
    <form onSubmit={submit} noValidate>
      <p className="muted">{S.backupSettings.intro}</p>
      {!backupPort && <Notice tone="info">{S.backupSettings.browser}</Notice>}
      {otherError != null && <Notice tone="bad">{errorMessage(otherError)}</Notice>}
      {test?.ok && <Notice tone="good">{S.backupSettings.ready(test.dir)}</Notice>}
      <Field label={S.backupSettings.folder} hint={S.backupSettings.hint} error={fieldError}>
        <TextInput
          value={dir}
          onChange={(e) => {
            setSaved(false);
            setTest(null);
            setDir(e.target.value);
          }}
          spellCheck={false}
          autoComplete="off"
          maxLength={500}
        />
      </Field>
      <div className="form-actions">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {S.settings.save}
        </Button>
        <Button
          disabled={!backupPort || testing || !dir.trim()}
          onClick={() => void testFolder(dir)}
        >
          {testing ? S.backupSettings.testing : S.backupSettings.test}
        </Button>
        {saved && <span className="muted">{S.settings.saved}</span>}
      </div>
    </form>
  );
}
