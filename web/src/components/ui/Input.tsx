import { useId, type InputHTMLAttributes, type ReactElement, type ReactNode } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';
import { Icon } from './Icon';

const CONTROL_CLASS =
  'w-full rounded-md border border-border bg-inset px-3 py-2 text-sm text-fg placeholder:text-fg-subtle ' +
  'shadow-[0_1px_2px_rgb(0_0_0/0.06)_inset] transition-[border-color,box-shadow] ' +
  'hover:border-border-strong focus:border-accent focus:ring-2 focus:ring-accent-ring focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-60 ' +
  'file:mr-3 file:rounded-sm file:border-0 file:bg-neutral-soft file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-fg';

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
        <p className="flex items-start gap-1 text-xs text-danger" role="alert">
          <Icon name="alert" className="mt-px h-3.5 w-3.5" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

export interface FieldGroupProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
}

/**
 * Legend + grouped controls + hint/error wrapper for radio and checkbox sets,
 * where no single control can carry the label's `htmlFor`.
 */
export function FieldGroup({
  label,
  hint,
  error,
  className,
  children,
}: FieldGroupProps): ReactElement {
  return (
    <fieldset className={cn('flex flex-col gap-1.5', className)}>
      <legend className="text-sm font-medium text-fg">{label}</legend>
      {children}
      {error ? (
        <p className="flex items-start gap-1 text-xs text-danger" role="alert">
          <Icon name="alert" className="mt-px h-3.5 w-3.5" />
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-subtle">{hint}</p>
      ) : null}
    </fieldset>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

/** Single-line text control. */
export function Input({ className, invalid, ...rest }: InputProps): ReactElement {
  return (
    <input
      className={cn(
        CONTROL_CLASS,
        invalid && 'border-danger focus:border-danger focus:ring-danger/30',
        className,
      )}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

export interface SearchInputProps extends InputProps {
  /** Width of the wrapper; defaults to a comfortable filter-bar width. */
  wrapperClassName?: string;
}

/** Search box with a leading magnifier, used by every filterable list. */
export function SearchInput({
  wrapperClassName,
  className,
  ...rest
}: SearchInputProps): ReactElement {
  return (
    <div className={cn('relative w-full max-w-sm', wrapperClassName)}>
      <Icon
        name="search"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle"
      />
      <Input type="search" className={cn('pl-9', className)} {...rest} />
    </div>
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
        invalid && 'border-danger focus:border-danger focus:ring-danger/30',
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
        className="mt-0.5 h-4 w-4 shrink-0 rounded-xs accent-[var(--accent)]"
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
