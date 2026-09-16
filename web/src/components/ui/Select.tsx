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
  /**
   * Extra classes. A width utility here (`w-44`, `w-full`) replaces the
   * default full width instead of fighting it.
   */
  className?: string;
  'aria-label'?: string;
}

const HAS_WIDTH = /(^|\s)(w-|min-w-|max-w-|basis-|flex-1)/;

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
          'flex h-9 items-center justify-between gap-2 rounded-md border border-border bg-inset px-3 text-left text-sm text-fg shadow-[0_1px_2px_rgb(0_0_0/0.06)_inset]',
          'transition-[border-color,box-shadow] hover:border-border-strong',
          'focus:border-accent focus:ring-2 focus:ring-accent-ring focus:outline-none',
          'data-[placeholder]:text-fg-subtle',
          'disabled:cursor-not-allowed disabled:opacity-60',
          !(className && HAS_WIDTH.test(className)) && 'w-full',
          className,
        )}
      >
        <span className="truncate">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon>
          <Icon name="chevron-down" className="h-4 w-4 shrink-0 text-fg-subtle" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          className="fx-pop animate-pop-in z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'relative flex cursor-pointer flex-col rounded-sm py-1.5 pr-3 pl-7 text-sm text-fg outline-none select-none',
                  'data-[highlighted]:bg-accent-soft data-[highlighted]:text-accent',
                  'data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50',
                )}
              >
                <SelectPrimitive.ItemIndicator className="absolute top-2 left-2 text-accent">
                  <Icon name="check" className="h-3.5 w-3.5" />
                </SelectPrimitive.ItemIndicator>
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
