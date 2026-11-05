/**
 * What a page-level read query means for the page that renders it.
 *
 * `isError || !data` conflates two different situations: the page never
 * loaded, and the page loaded but a later background refetch failed. TanStack
 * Query keeps the last good `data` in the second case, so replacing the page
 * with an error state there throws away everything the user typed into it.
 *
 * - `loading`: no data yet and a fetch is in flight.
 * - `failed`: no data and nothing in flight — the first load failed (or the
 *   query is disabled), so there is nothing to show.
 * - `ready`: data to show. `refetchFailed` says a background refetch failed
 *   after it, so the page keeps rendering (and keeps its edits) and can flag
 *   that what it shows may be stale.
 */
export type QueryLoadState<T> =
  { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; data: T; refetchFailed: boolean };

/** The fields of a `UseQueryResult` the derivation reads. */
export interface QueryLoadInput<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

export function queryLoadState<T>(query: QueryLoadInput<T>): QueryLoadState<T> {
  if (query.data !== undefined) {
    return { kind: 'ready', data: query.data, refetchFailed: query.isError };
  }
  return query.isLoading ? { kind: 'loading' } : { kind: 'failed' };
}
