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

const BODY_CAVEAT =
  'Request and response bodies are not validated at either level — only the path and method are checked.';

/**
 * What a provider is told before they change the level on a **live** API.
 *
 * The gateway builds the enforcement rules only for a route it created from the
 * document, and drops them only by rebuilding the route without it, so moving
 * between the levels recreates the route and the API answers `404` for a moment
 * (see the provider guide). Nothing else on this form does that, so a provider
 * who is not told would reasonably read it as another in-place setting.
 */
const REBUILD_WARNING =
  'Changing this rebuilds the API’s gateway route, so it is briefly unreachable — a second or so — while the change lands. Settings, plugins and client access all survive it.';

export interface SpecEnforcementSelectProps {
  value: SpecEnforcementLevel;
  onValueChange: (value: SpecEnforcementLevel) => void;
  /**
   * The level the API is published at, when it is already published. Passing it
   * turns on the interruption warning as soon as `value` moves away from it;
   * the publish form omits it, because there is nothing live to interrupt.
   */
  publishedLevel?: SpecEnforcementLevel;
  className?: string;
}

/** The "OpenAPI enforcement" select, with the body-validation caveat attached. */
export function SpecEnforcementSelect({
  value,
  onValueChange,
  publishedLevel,
  className,
}: SpecEnforcementSelectProps): ReactElement {
  const willRebuild = publishedLevel !== undefined && publishedLevel !== value;
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
      hint={
        willRebuild ? (
          <>
            {BODY_CAVEAT}
            <strong className="mt-1 block font-medium text-amber-700 dark:text-amber-500">
              {REBUILD_WARNING}
            </strong>
          </>
        ) : (
          BODY_CAVEAT
        )
      }
    />
  );
}
