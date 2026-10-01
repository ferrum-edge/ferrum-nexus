import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SpecDiff } from '@ferrum-nexus/shared';
import { SpecDiffView } from './SpecDiffView';

afterEach(cleanup);

/** A complete comparison that found nothing. */
const NOTHING: SpecDiff = {
  from: null,
  to: null,
  added_operations: [],
  removed_operations: [],
  changed_operations: [],
  added_paths: [],
  removed_paths: [],
  info_changes: [],
  servers_changed: false,
  potentially_breaking: [],
  complete: true,
  changed: false,
};

const SAME = /declares the same paths, methods and operations/;
const INCOMPLETE = 'This comparison is incomplete';

describe('SpecDiffView', () => {
  it('says the documents match when a complete comparison found nothing', () => {
    render(<SpecDiffView diff={NOTHING} />);
    expect(screen.getByText(SAME)).toBeInTheDocument();
    expect(screen.queryByText(INCOMPLETE)).not.toBeInTheDocument();
  });

  it('warns, and never says the documents match, when the comparison is incomplete', () => {
    const removed = [{ method: 'GET', path: '/receipts' }];
    render(
      <SpecDiffView
        diff={{
          ...NOTHING,
          removed_operations: removed,
          potentially_breaking: removed,
          complete: false,
          changed: true,
        }}
      />,
    );
    expect(screen.getByText(INCOMPLETE)).toBeInTheDocument();
    expect(screen.getByText(/changed operations are not listed/)).toBeInTheDocument();
    expect(screen.queryByText(SAME)).not.toBeInTheDocument();
    // What it could still find is shown.
    expect(screen.getAllByText('/receipts').length).toBeGreaterThan(0);
  });

  it('still warns when an incomplete comparison reports no change', () => {
    render(<SpecDiffView diff={{ ...NOTHING, complete: false }} />);
    expect(screen.getByText(INCOMPLETE)).toBeInTheDocument();
    expect(screen.queryByText(SAME)).not.toBeInTheDocument();
  });

  it('shows no warning for a comparison from a server that omits `complete`', () => {
    const older: Partial<SpecDiff> = { ...NOTHING };
    delete older.complete;
    render(
      <SpecDiffView diff={{ ...(older as SpecDiff), servers_changed: true, changed: true }} />,
    );
    expect(screen.queryByText(INCOMPLETE)).not.toBeInTheDocument();
  });
});
