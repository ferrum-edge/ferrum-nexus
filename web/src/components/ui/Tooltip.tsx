import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactElement, ReactNode } from 'react';

/** App-wide tooltip provider; mounted once in `App`. */
export function TooltipProvider({ children }: { children: ReactNode }): ReactElement {
  return (
    <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipProps {
  label: string;
  children: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

/** Hover/focus tooltip. The label is also exposed to assistive technology. */
export function Tooltip({ label, children, side = 'top' }: TooltipProps): ReactElement {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="fx-pop z-50 max-w-xs px-2.5 py-1.5 text-xs text-fg"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
