import type { InputHTMLAttributes, Ref } from 'react';
import { TextInput } from '../../ui';

/** A PIN box: hidden digits, number keypad on touch screens, no browser autofill. */
export function PinInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { ref?: Ref<HTMLInputElement> },
) {
  return (
    <TextInput
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={6}
      className="pin-input"
      {...props}
      onChange={(e) => {
        e.target.value = e.target.value.replace(/\D/g, '');
        props.onChange?.(e);
      }}
    />
  );
}
