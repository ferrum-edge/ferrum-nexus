import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, type RenderResult } from '@testing-library/react';
import { useId, type ReactElement, type ReactNode } from 'react';
import type { LabeledSelectProps } from '../src/components/ui/Select';
import { ToastProvider } from '../src/stores/toast';

const clients: QueryClient[] = [];

export function renderPage(element: ReactElement): RenderResult & { client: QueryClient } {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }): ReactElement => (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
  return Object.assign(render(element, { wrapper }), { client });
}

export function clearClients(): void {
  clients.splice(0).forEach((client) => client.clear());
}

export function selectTab(name: string): void {
  fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });
}

export function changeField(label: string | RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

// Match the existing route tests: native selects avoid Radix's layout/pointer
// requirements in jsdom. Keep hints and disabled options for policy assertions.
export function NativeLabeledSelect<T extends string>({
  label,
  value,
  onValueChange,
  options,
  hint,
  disabled,
}: LabeledSelectProps<T>): ReactElement {
  const id = useId();
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <p>{hint}</p> : null}
    </div>
  );
}

// Preserve concrete destinations while rendering pages without a router.
export function TestLink({
  to,
  params = {},
  children,
  className,
}: {
  to: string;
  params?: Record<string, string>;
  children: ReactNode;
  className?: string;
}): ReactElement {
  const href = to.replace(/\$(\w+)/g, (_match, key: string) => params[key] ?? '');
  return (
    <a href={href} className={className}>
      {children}
    </a>
  );
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
