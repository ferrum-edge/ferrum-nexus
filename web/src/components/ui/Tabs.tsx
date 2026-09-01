import * as TabsPrimitive from '@radix-ui/react-tabs';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '../../lib/cn';

/** One tab and its panel. */
export interface TabDefinition {
  value: string;
  label: string;
  content: ReactNode;
  /** Optional trailing count/badge rendered in the trigger. */
  badge?: ReactNode;
}

export interface TabsProps {
  tabs: TabDefinition[];
  value: string;
  onValueChange: (value: string) => void;
  className?: string;
}

/** Controlled tab set built on Radix. */
export function Tabs({ tabs, value, onValueChange, className }: TabsProps): ReactElement {
  return (
    <TabsPrimitive.Root value={value} onValueChange={onValueChange} className={cn(className)}>
      <TabsPrimitive.List className="flex flex-wrap items-center gap-1 border-b border-border">
        {tabs.map((tab) => (
          <TabsPrimitive.Trigger
            key={tab.value}
            value={tab.value}
            className={cn(
              '-mb-px inline-flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-fg-muted',
              'transition-colors hover:text-fg',
              'data-[state=active]:border-accent data-[state=active]:text-fg',
            )}
          >
            {tab.label}
            {tab.badge}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
      {tabs.map((tab) => (
        <TabsPrimitive.Content key={tab.value} value={tab.value} className="pt-5 outline-none">
          {tab.content}
        </TabsPrimitive.Content>
      ))}
    </TabsPrimitive.Root>
  );
}
