import type { ReactElement, ReactNode } from 'react';
import { ACCOUNT_IDENTITY_SCOPE, type Application } from '@ferrum-nexus/shared';
import { queryKeys } from '../../hooks/keys';
import { applicationsApi } from '../../lib/api';
import { AsyncSelect } from '../ui/AsyncSelect';
import type { SelectOption } from '../ui/Select';

/** The "my account" choice; a select has no `null`. */
export const ACCOUNT_IDENTITY = ACCOUNT_IDENTITY_SCOPE;

/** The account's own identity as a picker option. */
const ACCOUNT_OPTION: SelectOption = { value: ACCOUNT_IDENTITY, label: 'My account' };

export interface IdentityPickerProps {
  label: string;
  /** {@link ACCOUNT_IDENTITY} or an application id. */
  value: string;
  /** Called with the chosen value and its display name. */
  onValueChange: (value: string, name: string) => void;
  /** The chosen application's name when known from elsewhere. */
  selectedLabel?: string;
  hint?: ReactNode;
  disabled?: boolean;
  /**
   * Also offer disabled applications, labelled as such. For managing access an
   * identity already holds: a disabled application keeps its grants and may
   * give them up, though it cannot acquire new ones.
   */
  includeDisabled?: boolean;
}

function toOption(application: Application): SelectOption {
  return {
    value: application.id,
    label: application.status === 'disabled' ? `${application.name} (disabled)` : application.name,
    ...(application.description ? { description: application.description } : {}),
  };
}

/**
 * Choose which of the caller's identities to act as: the account itself, or
 * one of its **active** applications.
 *
 * Only the caller's own (`mine`), even for an administrator, because nobody
 * may act as somebody else's application; only active ones, because a disabled
 * application is refused new access and new credentials. The list is searched
 * and paged on the server, so an account with more applications than one page
 * holds can still reach every one of them (issue #310).
 */
export function IdentityPicker({
  label,
  value,
  onValueChange,
  selectedLabel,
  hint,
  disabled,
  includeDisabled = false,
}: IdentityPickerProps): ReactElement {
  return (
    <AsyncSelect<Application>
      label={label}
      value={value}
      onValueChange={(next, option) => onValueChange(next, option.label)}
      queryKey={
        includeDisabled
          ? [...queryKeys.applications.picker, 'include-disabled']
          : queryKeys.applications.picker
      }
      fetchPage={({ q, limit, offset }) =>
        applicationsApi.list({
          mine: true,
          ...(includeDisabled ? {} : { status: 'active' as const }),
          ...(q !== '' ? { q } : {}),
          limit,
          offset,
        })
      }
      toOption={toOption}
      fixedOptions={[ACCOUNT_OPTION]}
      selectedLabel={selectedLabel}
      hint={hint}
      searchPlaceholder="Search your applications"
      emptyLabel={includeDisabled ? 'No application matches.' : 'No active application matches.'}
      disabled={disabled}
    />
  );
}
