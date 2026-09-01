import { useId, type InputHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const CONTROL_CLASS =
  'w-full rounded-md border border-border bg-inset px-3 py-2 text-sm text-fg placeholder:text-fg-subtle ' +
  'transition-colors hover:border-border-strong focus:border-accent focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

export interface FieldProps {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint/error wrapper; every form control uses one. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: FieldProps): ReactElement {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
        {required ? (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

/** Single-line text control. */
export function Input({ className, invalid, ...rest }: InputProps): ReactElement {
  return (
    <input
      className={cn(CONTROL_CLASS, invalid && 'border-danger', className)}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
}

/** Multi-line text control; `mono` switches to the monospace stack for specs. */
export function Textarea({ className, invalid, mono, ...rest }: TextareaProps): ReactElement {
  return (
    <textarea
      className={cn(
        CONTROL_CLASS,
        'min-h-24 resize-y',
        mono && 'font-mono text-xs leading-relaxed',
        invalid && 'border-danger',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface LabeledInputProps extends InputProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

/** Convenience wrapper pairing {@link Field} with {@link Input}. */
export function LabeledInput({
  label,
  hint,
  error,
  required,
  className,
  ...rest
}: LabeledInputProps): ReactElement {
  const generatedId = useId();
  const id = rest.id ?? generatedId;
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      <Input id={id} required={required} invalid={Boolean(error)} {...rest} />
    </Field>
  );
}

export interface LabeledTextareaProps extends TextareaProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

/** Convenience wrapper pairing {@link Field} with {@link Textarea}. */
export function LabeledTextarea({
  label,
  hint,
  error,
  required,
  className,
  ...rest
}: LabeledTextareaProps): ReactElement {
  const generatedId = useId();
  const id = rest.id ?? generatedId;
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      <Textarea id={id} required={required} invalid={Boolean(error)} {...rest} />
    </Field>
  );
}

/** Checkbox with an inline label, used for booleans on settings forms. */
export function Checkbox({
  label,
  description,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }): ReactElement {
  const generatedId = useId();
  const id = rest.id ?? generatedId;
  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <input
        id={id}
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
        {...rest}
      />
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium text-fg">
          {label}
        </label>
        {description ? <p className="text-xs text-fg-subtle">{description}</p> : null}
      </div>
    </div>
  );
}
