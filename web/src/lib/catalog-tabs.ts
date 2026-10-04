/**
 * The tabs of a catalog entry's page, which a link may open directly with
 * `?tab=`: the spec-change notification opens `changes`, for one.
 *
 * Kept apart from both the page and the router so each can import it without
 * importing the other.
 */

export const CATALOG_DETAIL_TABS = ['overview', 'docs', 'changes', 'agents', 'access'] as const;

export type CatalogDetailTab = (typeof CATALOG_DETAIL_TABS)[number];

/** Whether `value` names one of {@link CATALOG_DETAIL_TABS}. */
export function isCatalogDetailTab(value: unknown): value is CatalogDetailTab {
  return typeof value === 'string' && (CATALOG_DETAIL_TABS as readonly string[]).includes(value);
}
