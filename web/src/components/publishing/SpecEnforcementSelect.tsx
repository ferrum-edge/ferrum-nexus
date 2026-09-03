import { type ReactElement } from 'react';
import { SPEC_ENFORCEMENT_LEVELS, type SpecEnforcementLevel } from '@ferrum-nexus/shared';
import { LabeledSelect } from '../ui/Select';

/**
 * How much of the uploaded document the gateway enforces.
 *
 * Shared by the publish form and the API settings tab so the two never drift on
 * the one piece of copy that matters here: `routes` checks the *path and
 * method*, and bodies are not validated at either level. A provider who reads
 * "OpenAPI enforcement" and assumes their request schemas are being applied has
 * been misled, which is the mistake issue #38 was filed about in the first
 * place.
 */
const LEVEL_LABELS: Readonly<Record<SpecEnforcementLevel, string>> = {
  docs_only: 'Documentation only (default)',
  routes: 'Reject requests to paths and methods not in the spec',
};

const LEVEL_DESCRIPTIONS: Readonly<Record<SpecEnforcementLevel, string>> = {
  docs_only: 'The document is catalog metadata; the gateway forwards any path.',
  routes: 'The gateway answers 400 for an undeclared path or method.',
};

export interface SpecEnforcementSelectProps {
  value: SpecEnforcementLevel;
  onValueChange: (value: SpecEnforcementLevel) => void;
  className?: string;
}

/** The "OpenAPI enforcement" select, with the body-validation caveat attached. */
export function SpecEnforcementSelect({
  value,
  onValueChange,
  className,
}: SpecEnforcementSelectProps): ReactElement {
  return (
    <LabeledSelect<SpecEnforcementLevel>
      className={className}
      label="OpenAPI enforcement"
      value={value}
      onValueChange={onValueChange}
      options={SPEC_ENFORCEMENT_LEVELS.map((level) => ({
        value: level,
        label: LEVEL_LABELS[level],
        description: LEVEL_DESCRIPTIONS[level],
      }))}
      hint="Request and response bodies are not validated at either level — only the path and method are checked."
    />
  );
}
