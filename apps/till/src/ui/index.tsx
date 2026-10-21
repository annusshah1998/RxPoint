import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { S } from '../strings';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'normal' | 'small';
};

export function Button({
  variant = 'secondary',
  size = 'normal',
  className = '',
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={`btn btn-${variant} btn-${size} ${className}`} {...props} />
  );
}

/** Lets the control inside a Field pick up its id, description and invalid state. */
const FieldContext = createContext<{ id: string; describedBy?: string; invalid: boolean } | null>(
  null,
);

function useFieldProps(props: { id?: string; 'aria-describedby'?: string }) {
  const field = useContext(FieldContext);
  if (!field) return {};
  return {
    id: props.id ?? field.id,
    'aria-describedby': props['aria-describedby'] ?? field.describedBy,
    'aria-invalid': field.invalid || undefined,
  };
}

/**
 * A labelled form control. The label names the control; the hint or error describes it
 * (so screen readers announce "Strength", then "As printed, e.g. 625mg").
 */
export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div className={`field ${error ? 'field-invalid' : ''} ${className}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <FieldContext.Provider
        value={{ id, describedBy: note ? noteId : undefined, invalid: !!error }}
      >
        {children}
      </FieldContext.Provider>
      {error ? (
        <span className="field-error" id={noteId} role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint" id={noteId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function TextInput({
  ref,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const field = useFieldProps(props);
  return <input ref={ref} className={`input ${className}`} {...props} {...field} />;
}

export function TextArea({
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useFieldProps(props);
  return <textarea className={`input ${className}`} rows={2} {...props} {...field} />;
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useFieldProps(props);
  return <select className={`input ${className}`} {...props} {...field} />;
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-header">
          {title && <h2 className="card-title">{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  onBack,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <header className="page-header">
      <div>
        {onBack && (
          <button type="button" className="back-link" onClick={onBack}>
            ← {S.common.back}
          </button>
        )}
        <h1 className="page-title">{title}</h1>
        {subtitle && <div className="page-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return <div className="loading">{S.common.loading}</div>;
}

/** A centred dialog. Escape or the close button dismisses it. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={String(title)} ref={ref}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label={S.common.close} onClick={onClose}>
            ×
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
