import { PRODUCT } from '@app/config';
import { S } from '../../strings';
import { Button } from '../../ui';

/** Shows the owner's recovery code once, after setup or a reset. */
export function RecoveryCodeScreen({ code, onDone }: { code: string; onDone: () => void }) {
  return (
    <div className="setup">
      <div className="card setup-card">
        <div className="brand brand-large">{PRODUCT.name}</div>
        <h1 className="page-title">{S.auth.codeTitle}</h1>
        <p className="muted">{S.auth.codeIntro}</p>
        <p className="recovery-code" aria-label={S.auth.recoveryCode}>
          {code}
        </p>
        <p className="muted">{S.auth.codeNext}</p>
        <Button variant="primary" onClick={onDone} autoFocus>
          {S.auth.codeConfirm}
        </Button>
      </div>
    </div>
  );
}
