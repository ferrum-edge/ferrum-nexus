import * as SelectPrimitive from '@radix-ui/react-select';
import { useId, type ReactElement, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Field } from './Input';
import { Icon } from './Icon';

/** One choice in a {@link Select}. */
export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/** Accessible select built on Radix; pages never import Radix directly. */
export function Select<T extends string = string>({
  value,
  onValueChange,
  options,
  id,
  placeholder = 'Select…',
  disabled,
  className,
  'aria-label': ariaLabel,
}: SelectProps<T>): ReactElement {
  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-inset px-3 text-sm text-fg',
          'transition-colors hover:border-border-strong focus:border-accent focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <Icon name="chevron-down" className="h-4 w-4 text-fg-subtle" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="fx-pop z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex cursor-pointer flex-col rounded-sm px-2.5 py-1.5 text-sm text-fg outline-none select-none',
                  'data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
                )}
              >
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                {option.description ? (
                  <span className="text-xs text-fg-subtle">{option.description}</span>
                ) : null}
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export interface LabeledSelectProps<T extends string = string> extends SelectProps<T> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
}

/** {@link Select} wrapped in a {@link Field}. */
export function LabeledSelect<T extends string = string>({
  label,
  hint,
  error,
  required,
  className,
  ...rest
}: LabeledSelectProps<T>): ReactElement {
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
      <Select<T> {...rest} id={id} aria-label={rest['aria-label'] ?? label} />
    </Field>
  );
}
