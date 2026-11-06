import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import k from './kit.module.css';

export type FieldProps = {
  label: ReactNode;
  /** id of the control inside. */
  htmlFor: string;
  hint?: ReactNode;
  /** Shown in coral under the control. Also pass `invalid` to the control. */
  error?: ReactNode;
  optional?: boolean;
  children: ReactNode;
  className?: string;
};

/** Label, control, hint and error. Hint and error ids are `${htmlFor}-hint` and `${htmlFor}-error` for aria-describedby. */
export function Field({ label, htmlFor, hint, error, optional, children, className }: FieldProps) {
  return (
    <div className={[k.field, className].filter(Boolean).join(' ')}>
      <label htmlFor={htmlFor} className={k.fieldLabel}>
        <span>{label}</span>
        {optional && <span className={k.fieldOptional}>Optional</span>}
      </label>
      {children}
      {hint && !error && (
        <p id={`${htmlFor}-hint`} className={k.fieldHint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${htmlFor}-error`} className={k.fieldError} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

type ControlExtras = {
  invalid?: boolean;
  /** Mono text, for amounts, account ids and hashes. */
  mono?: boolean;
};

function controlClass(invalid?: boolean) {
  return [k.control, invalid && k.controlInvalid].filter(Boolean).join(' ');
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> &
  ControlExtras & {
    /** Unit shown inside the right edge, e.g. "USDC". */
    suffix?: ReactNode;
  };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ invalid, mono, suffix, className, ...rest }, ref) {
  return (
    <span className={controlClass(invalid)}>
      <input
        ref={ref}
        className={[k.input, mono && k.inputMono, className].filter(Boolean).join(' ')}
        aria-invalid={invalid || undefined}
        {...rest}
      />
      {suffix && <span className={k.suffix}>{suffix}</span>}
    </span>
  );
});

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & ControlExtras;

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ invalid, mono, className, children, ...rest }, ref) {
  return (
    <span className={controlClass(invalid)}>
      <select
        ref={ref}
        className={[k.select, mono && k.inputMono, className].filter(Boolean).join(' ')}
        aria-invalid={invalid || undefined}
        {...rest}
      >
        {children}
      </select>
    </span>
  );
});

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & ControlExtras;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ invalid, mono, className, ...rest }, ref) {
  return (
    <span className={controlClass(invalid)}>
      <textarea
        ref={ref}
        className={[k.textarea, mono && k.inputMono, className].filter(Boolean).join(' ')}
        aria-invalid={invalid || undefined}
        {...rest}
      />
    </span>
  );
});
