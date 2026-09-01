import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { Icon } from './Icon';

export interface CopyFieldProps {
  label: string;
  value: string;
  /** Render the value in a monospace block (secrets, ids, URLs). */
  mono?: boolean;
  className?: string;
}

/** Read-only value with a copy-to-clipboard affordance. */
export function CopyField({ label, value, mono = true, className }: CopyFieldProps): ReactElement {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be denied (insecure context, permissions); the
      // value stays selectable so the user can copy it by hand.
      setCopied(false);
    }
  }, [value]);

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium tracking-wide text-fg-subtle uppercase">{label}</span>
      <div className="flex items-stretch gap-2">
        <code
          className={cn(
            'min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-inset px-3 py-2 text-sm break-all text-fg',
            mono && 'font-mono text-xs',
          )}
        >
          {value}
        </code>
        <Button
          size="icon"
          variant="secondary"
          onClick={() => void copy()}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          title={`Copy ${label}`}
        >
          <Icon name={copied ? 'check' : 'copy'} className={copied ? 'text-success' : undefined} />
        </Button>
      </div>
    </div>
  );
}
