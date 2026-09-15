import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

/** Visual weight of a button. */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link' | 'outline';

/** Control height. */
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Replaces the content with a spinner and disables interaction. */
  loading?: boolean;
  children?: ReactNode;
}

const BASE =
  'inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap ' +
  'transition-[background-color,border-color,color,box-shadow,transform] duration-150 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-2 focus-visible:ring-offset-base ' +
  'disabled:cursor-not-allowed disabled:opacity-55 disabled:shadow-none active:translate-y-px';

const VARIANTS: Readonly<Record<ButtonVariant, string>> = {
  primary:
    'bg-accent text-accent-fg border-accent shadow-[0_1px_0_rgb(255_255_255/0.12)_inset,0_1px_2px_rgb(0_0_0/0.25)] ' +
    'hover:bg-accent-hover hover:border-accent-hover hover:shadow-[0_1px_0_rgb(255_255_255/0.14)_inset,0_4px_12px_-4px_var(--accent-glow)] ' +
    'active:bg-accent-active',
  secondary:
    'bg-elevated text-fg border-border shadow-[0_1px_2px_rgb(0_0_0/0.08)] hover:border-border-strong hover:bg-surface-hover',
  outline: 'bg-transparent text-fg border-border-strong hover:bg-neutral-soft',
  ghost: 'bg-transparent text-fg-muted border-transparent hover:bg-neutral-soft hover:text-fg',
  danger:
    'bg-danger text-white border-danger shadow-[0_1px_2px_rgb(0_0_0/0.25)] hover:bg-danger-hover hover:border-danger-hover',
  link: 'bg-transparent border-transparent text-accent hover:underline px-0 h-auto',
};

const SIZES: Readonly<Record<ButtonSize, string>> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
  icon: 'h-9 w-9 gap-0',
  'icon-sm': 'h-8 w-8 gap-0',
};

export interface ButtonClassOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}

/**
 * The button's class list on its own, for anchors and router links that should
 * look like a button without rendering a nested `<button>`.
 */
export function buttonClassName({
  variant = 'secondary',
  size = 'md',
  className,
}: ButtonClassOptions = {}): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

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
      aria-busy={loading || undefined}
      className={buttonClassName({ variant, size, className })}
      {...rest}
    >
      {loading ? <Spinner className="h-4 w-4 text-current" /> : null}
      {children}
    </button>
  );
}
