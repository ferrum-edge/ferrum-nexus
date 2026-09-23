import { keepPreviousData, useQuery, type QueryKey } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactElement, type ReactNode } from 'react';
import { DEFAULT_PAGE_SIZE, type Paginated } from '@ferrum-nexus/shared';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { Icon } from './Icon';
import { Field } from './Input';
import type { SelectOption } from './Select';

/** What {@link AsyncSelect} asks its list endpoint for. */
export interface AsyncSelectPageParams {
  /** The trimmed search text; empty when the user has not typed anything. */
  q: string;
  limit: number;
  offset: number;
}

export interface AsyncSelectProps<TItem> {
  label: string;
  value: string;
  /** Called with the chosen value and the option it came from. */
  onValueChange: (value: string, option: SelectOption) => void;
  /**
   * Cache-key prefix for the pages; the search text, limit and offset are
   * appended. Put it under the resource's key so that resource's mutations
   * invalidate what the picker shows.
   */
  queryKey: QueryKey;
  /** One page of the list endpoint, searched server-side by `q`. */
  fetchPage: (params: AsyncSelectPageParams) => Promise<Paginated<TItem>>;
  toOption: (item: TItem) => SelectOption;
  /**
   * Choices that are not rows of the endpoint — "My account" beside a list of
   * applications. Listed first on the first page, and filtered by the search
   * text on the client since the server knows nothing about them.
   */
  fixedOptions?: ReadonlyArray<SelectOption>;
  /**
   * What to show for `value` before it has been seen in a loaded page, such
   * as an id restored from elsewhere. Falls back to the value itself.
   */
  selectedLabel?: string;
  pageSize?: number;
  hint?: ReactNode;
  searchPlaceholder?: string;
  /** Shown when a page comes back empty. */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}

/** How long typing pauses before the search is sent. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * A searchable, paginated select over a list endpoint.
 *
 * The ordinary {@link Select} needs every option up front, which quietly turns
 * one `MAX_PAGE_SIZE` page into "all of them" — and past that page a choice
 * simply cannot be made. This asks the server instead: the search text goes
 * out as `q`, results come back a page at a time with the server's `total`,
 * and every row the endpoint can return is reachable by searching or paging.
 *
 * Nothing is fetched until the list is opened. The panel renders inline rather
 * than in a portal so it works inside a dialog's focus trap.
 */
export function AsyncSelect<TItem>({
  label,
  value,
  onValueChange,
  queryKey,
  fetchPage,
  toOption,
  fixedOptions = [],
  selectedLabel,
  pageSize = DEFAULT_PAGE_SIZE,
  hint,
  searchPlaceholder = 'Search…',
  emptyLabel = 'No matches.',
  disabled,
  className,
}: AsyncSelectProps<TItem>): ReactElement {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // The offset belongs to one search: a new search starts again at its first
  // page without an effect having to reset it.
  const [paging, setPaging] = useState({ q: '', offset: 0 });
  const offset = paging.q === q ? paging.offset : 0;
  const setOffset = (next: number): void => setPaging({ q, offset: next });
  // Labels of options picked from a loaded page, so the trigger can still
  // name the choice once that page is no longer the one on screen.
  const [picked, setPicked] = useState<SelectOption | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [search]);

  const page = useQuery({
    queryKey: [...queryKey, { q, limit: pageSize, offset }],
    queryFn: () => fetchPage({ q, limit: pageSize, offset }),
    enabled: open && !disabled,
    placeholderData: keepPreviousData,
  });

  const needle = q.toLowerCase();
  const fixed =
    offset === 0
      ? fixedOptions.filter(
          (option) => needle === '' || option.label.toLowerCase().includes(needle),
        )
      : [];
  const fetched = (page.data?.items ?? []).map(toOption);
  const options = [...fixed, ...fetched];
  const total = page.data?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + pageSize, total);

  const current =
    fixedOptions.find((option) => option.value === value) ??
    (picked?.value === value ? picked : undefined) ??
    options.find((option) => option.value === value);
  const currentLabel = current?.label ?? selectedLabel ?? value;

  const choose = (option: SelectOption): void => {
    if (option.disabled) return;
    setPicked(option);
    setOpen(false);
    onValueChange(option.value, option);
  };

  return (
    <Field label={label} htmlFor={id} hint={hint} className={className}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((next) => !next)}
        className={cn(
          'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-inset px-3 text-left text-sm text-fg shadow-[0_1px_2px_rgb(0_0_0/0.06)_inset]',
          'transition-[border-color,box-shadow] hover:border-border-strong',
          'focus:border-accent focus:ring-2 focus:ring-accent-ring focus:outline-none',
          'disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <span className="truncate">{currentLabel}</span>
        <Icon
          name="chevron-down"
          className={cn(
            'h-4 w-4 shrink-0 text-fg-subtle transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <div className="fx-card flex flex-col gap-2 p-2">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={`Search ${label}`}
            aria-controls={listId}
            maxLength={200}
            className="h-8 w-full min-w-0 rounded-md border border-border bg-inset px-2.5 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-2 focus:ring-accent-ring focus:outline-none"
          />
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            aria-busy={page.isFetching || undefined}
            className="max-h-60 overflow-y-auto"
          >
            {options.map((option) => (
              <li
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                tabIndex={option.disabled ? -1 : 0}
                onClick={() => choose(option)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    choose(option);
                  }
                }}
                className={cn(
                  'relative flex cursor-pointer flex-col rounded-sm py-1.5 pr-3 pl-7 text-sm text-fg outline-none select-none',
                  'hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent',
                  option.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                {option.value === value ? (
                  <Icon name="check" className="absolute top-2 left-2 h-3.5 w-3.5 text-accent" />
                ) : null}
                <span className="truncate">{option.label}</span>
                {option.description ? (
                  <span className="truncate text-xs text-fg-subtle">{option.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {page.isLoading ? (
            <p className="px-2 text-xs text-fg-subtle">Loading…</p>
          ) : page.isError ? (
            <p className="px-2 text-xs text-danger" role="alert">
              Could not load the choices. Try again in a moment.
            </p>
          ) : fetched.length === 0 && fixed.length === 0 ? (
            <p className="px-2 text-xs text-fg-subtle">{emptyLabel}</p>
          ) : null}
          {total > pageSize ? (
            <div className="flex items-center justify-between gap-2 border-t border-border px-1 pt-2">
              <p className="text-xs text-fg-muted tabular-nums">
                {first}–{last} of {total}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={offset <= 0 || page.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - pageSize))}
                  aria-label={`Previous ${label} results`}
                >
                  <Icon name="chevron-left" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={offset + pageSize >= total || page.isFetching}
                  onClick={() => setOffset(offset + pageSize)}
                  aria-label={`More ${label} results`}
                >
                  <Icon name="chevron-right" />
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Field>
  );
}
