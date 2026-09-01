import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

/** Visual weight of a button. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link';

/** Control height. */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Replaces the content with a spinner and disables interaction. */
  loading?: boolean;
  children?: ReactNode;
}

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active border-accent',
  secondary: 'bg-elevated text-fg border-border hover:border-border-strong hover:bg-inset',
  ghost: 'bg-transparent text-fg-muted border-transparent hover:bg-neutral-soft hover:text-fg',
  danger: 'bg-danger text-accent-fg border-danger hover:bg-danger-hover',
  link: 'bg-transparent border-transparent text-accent hover:underline px-0',
};

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
  icon: 'h-9 w-9 justify-center',
};

/** The single button primitive; pages never style a bare `<button>`. */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center rounded-md border font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-55',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}
