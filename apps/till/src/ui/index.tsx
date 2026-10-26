import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { S } from '../strings';
import { matchOptions } from './match-options';

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

/**
 * A text box with suggestions listed under it, for names staff usually pick from earlier
 * entries but may also type fresh (manufacturer, salt). Typing, a click or ↓ opens the
 * list; ↑/↓ move, Enter picks, Escape closes. The list is drawn in the page under its
 * box (not by the browser), so it matches the rest of the till and scrolls with the form.
 */
export function Combobox({
  value,
  onChange,
  options,
  className = '',
  onKeyDown,
  onBlur,
  onClick,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'list'> & {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
}) {
  const field = useFieldProps(props);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const matches = matchOptions(options, value);
  const shown = open && matches.length > 0;
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => {
    if (shown && active >= 0)
      listRef.current?.children[active]?.scrollIntoView?.({ block: 'nearest' });
  }, [shown, active]);

  function close() {
    setOpen(false);
    setActive(-1);
  }

  function pick(option: string) {
    onChange(option);
    close();
  }

  function keyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!shown) {
        setOpen(true);
        setActive(0);
      } else setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp' && shown) {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, -1));
    } else if (e.key === 'Enter' && shown && active >= 0) {
      // Pick the highlighted name instead of saving the form.
      e.preventDefault();
      pick(matches[active]!);
    } else if (e.key === 'Escape' && shown) {
      // Close the list only, not a dialog the box sits in.
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  return (
    <div className="combobox">
      <input
        className={`input ${className}`}
        autoComplete="off"
        {...props}
        {...field}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={shown ? listId : undefined}
        aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={keyDown}
        onClick={(e) => {
          onClick?.(e);
          setOpen(true);
        }}
        onBlur={(e) => {
          close();
          onBlur?.(e);
        }}
      />
      {shown && (
        <ul
          className="combobox-list"
          id={listId}
          role="listbox"
          aria-label={S.common.suggestions}
          ref={listRef}
        >
          {matches.map((option, i) => (
            <li
              key={option}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                // Keep focus in the box so the click picks instead of blurring first.
                e.preventDefault();
                pick(option);
              }}
            >
              {option}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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

// Open dialogs, oldest first. Escape closes only the newest (F1 help over Pay closes alone).
const openModals: object[] = [];

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
  // The latest onClose, so Escape works without re-subscribing on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    const me = {};
    openModals.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || openModals.at(-1) !== me) return;
      // Marks the key as used, in case the dialog below already counts as the newest.
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      openModals.splice(openModals.indexOf(me), 1);
    };
  }, []);

  // Put the cursor in the dialog once, so typing and Enter act on it: on a control that
  // asked for it (autoFocus), else the first box, else the first button (never the ×).
  // A dialog still loading holds the cursor itself until its first control appears.
  // After that, re-renders (the Sale screen redraws while Pay is open) leave it alone.
  const placed = useRef(false);
  useEffect(() => {
    const modal = ref.current;
    if (placed.current || !modal) return;
    const inBody = (el: Element | null) =>
      el !== null && el !== modal && modal.contains(el) && !el.closest('.modal-header');
    if (inBody(document.activeElement)) {
      placed.current = true;
      return;
    }
    const body = (selector: string) =>
      Array.from(modal.querySelectorAll<HTMLElement>(selector)).find(inBody);
    const first =
      body(
        'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)',
      ) ?? body('button:not(:disabled)');
    if (first) {
      first.focus();
      placed.current = true;
    } else {
      modal.focus();
    }
  });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={String(title)}
        tabIndex={-1}
        ref={ref}
      >
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
