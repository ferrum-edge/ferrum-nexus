/**
 * Toast store built on Radix Toast.
 *
 * Besides the React hook, the provider registers itself as a module-level sink
 * so the React Query cache handlers (created outside the component tree) can
 * surface mutation/query failures without prop-drilling.
 */

import * as ToastPrimitive from '@radix-ui/react-toast';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '../lib/cn';

/** Visual severity of a toast. */
export type ToastVariant = 'success' | 'error' | 'info';

/** A toast waiting on (or currently on) screen. */
export interface ToastMessage {
  id: string;
  title: string;
  description?: string | undefined;
  variant: ToastVariant;
}

export interface ToastOptions {
  description?: string | undefined;
  variant?: ToastVariant;
}

interface ToastContextValue {
  toasts: ToastMessage[];
  push: (title: string, options?: ToastOptions) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

type ToastSink = (title: string, options?: ToastOptions) => void;

let sink: ToastSink | null = null;

/** Push a toast from outside React (React Query cache handlers). */
export function emitToast(title: string, options?: ToastOptions): void {
  sink?.(title, options);
}

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const push = useCallback((title: string, options?: ToastOptions) => {
    nextId += 1;
    const entry: ToastMessage = {
      id: `toast-${nextId}`,
      title,
      description: options?.description,
      variant: options?.variant ?? 'info',
    };
    setToasts((current) => [...current.slice(-3), entry]);
  }, []);

  const success = useCallback(
    (title: string, description?: string) => push(title, { description, variant: 'success' }),
    [push],
  );
  const error = useCallback(
    (title: string, description?: string) => push(title, { description, variant: 'error' }),
    [push],
  );

  useEffect(() => {
    sink = push;
    return () => {
      sink = null;
    };
  }, [push]);

  const value = useMemo<ToastContextValue>(
    () => ({ toasts, push, success, error, dismiss }),
    [toasts, push, success, error, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right" duration={6000}>
        {children}
        {toasts.map((entry) => (
          <ToastPrimitive.Root
            key={entry.id}
            open
            onOpenChange={(open) => {
              if (!open) dismiss(entry.id);
            }}
            className={cn(
              'fx-pop grid grid-cols-[1fr_auto] items-start gap-3 p-4',
              'data-[state=closed]:opacity-0',
              entry.variant === 'success' && 'border-l-4 border-l-success',
              entry.variant === 'error' && 'border-l-4 border-l-danger',
              entry.variant === 'info' && 'border-l-4 border-l-info',
            )}
          >
            <div className="min-w-0">
              <ToastPrimitive.Title className="text-sm font-semibold text-fg">
                {entry.title}
              </ToastPrimitive.Title>
              {entry.description ? (
                <ToastPrimitive.Description className="mt-1 text-sm break-words text-fg-muted">
                  {entry.description}
                </ToastPrimitive.Description>
              ) : null}
            </div>
            <ToastPrimitive.Close
              aria-label="Dismiss notification"
              className="rounded-sm px-1 text-fg-subtle hover:text-fg"
            >
              ✕
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed right-4 bottom-4 z-100 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

/** Access the toast store; throws when used outside {@link ToastProvider}. */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within a ToastProvider');
  return context;
}
