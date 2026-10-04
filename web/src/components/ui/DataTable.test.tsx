import { useState, type ReactElement } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, expectTypeOf, it, vi, type Matchers } from 'vitest';

import { DataTable, type Columns } from './DataTable';

interface Item {
  id: string;
  name: string;
}

const columns: Columns<Item> = [
  { accessorKey: 'name', header: 'Name' },
  { id: 'identity', header: 'Identity', cell: ({ row }) => row.original.id },
];
const page: Item[] = [
  { id: 'bravo', name: 'Bravo' },
  { id: 'alpha', name: 'Alpha' },
];

afterEach(cleanup);

describe('DataTable with Table 9', () => {
  it('renders accessor and custom cells in the server order without slicing an offset page', () => {
    const onOffsetChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={page}
        total={7}
        offset={4}
        limit={2}
        onOffsetChange={onOffsetChange}
      />,
    );
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]!).getByRole('cell', { name: 'Bravo' })).toBeInTheDocument();
    expect(within(rows[2]!).getByRole('cell', { name: 'alpha' })).toBeInTheDocument();
    expect(screen.getByText('5–6')).toBeInTheDocument();
    expect(screen.getByText(/page 3 of 4/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onOffsetChange).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onOffsetChange).toHaveBeenLastCalledWith(6);
  });

  it('takes changed ordering and filtered data from the parent query and retains its toolbar', () => {
    const props = {
      columns,
      onOffsetChange: vi.fn(),
      limit: 2,
      toolbar: <input aria-label="Search directory" defaultValue="Alpha" />,
    };
    const { rerender } = render(<DataTable {...props} data={page} total={7} offset={4} />);
    rerender(<DataTable {...props} data={[page[1]!, page[0]!]} total={7} offset={4} />);
    expect(within(screen.getAllByRole('row')[1]!).getByText('Alpha')).toBeInTheDocument();
    rerender(<DataTable {...props} data={[page[1]!]} total={1} offset={0} />);
    expect(screen.getByRole('textbox', { name: 'Search directory' })).toHaveValue('Alpha');
    expect(screen.getByRole('cell', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Bravo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('keeps stateful cells attached to entity ids when the page order changes', () => {
    function Counter(): ReactElement {
      const [count, setCount] = useState(0);
      return <button onClick={() => setCount(count + 1)}>Count {count}</button>;
    }
    const stateful: Columns<Item> = [columns[0]!, { id: 'counter', cell: Counter }];
    const { rerender } = render(<DataTable columns={stateful} data={page} />);
    fireEvent.click(within(screen.getAllByRole('row')[1]!).getByRole('button'));
    rerender(<DataTable columns={stateful} data={[page[1]!, page[0]!]} />);
    expect(within(screen.getAllByRole('row')[1]!).getByRole('button')).toHaveTextContent('Count 0');
    expect(within(screen.getAllByRole('row')[2]!).getByRole('button')).toHaveTextContent('Count 1');
  });

  it('retains pointer and keyboard activation using the current original row', () => {
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} data={page} onRowClick={onRowClick} />);
    const row = screen.getAllByRole('row')[1]!;
    expect(row).toHaveAttribute('tabindex', '0');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(onRowClick).toHaveBeenCalledTimes(3);
    expect(onRowClick).toHaveBeenLastCalledWith(page[0]);
    fireEvent.keyDown(row, { key: 'Escape' });
    expect(onRowClick).toHaveBeenCalledTimes(3);
  });

  it('retains loading, error and empty states plus pagination boundaries', () => {
    const props = { columns, data: [] as Item[], total: 3, limit: 2, onOffsetChange: vi.fn() };
    const { rerender } = render(<DataTable {...props} loading empty="No rows" />);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('row')).toHaveLength(6);
    expect(screen.queryByText('No rows')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    rerender(<DataTable {...props} error={<span role="alert">Try again</span>} offset={2} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Try again');
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    rerender(<DataTable {...props} total={0} empty="No rows" />);
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-busy');
    expect(screen.getByText('No rows')).toBeInTheDocument();
  });

  it('keeps typed jest-dom matcher arguments and synchronous/promise return types', async () => {
    render(<DataTable columns={columns} data={page} />);
    const table = screen.getByRole('table');
    expectTypeOf<Matchers<void, HTMLElement>['toHaveAttribute']>()
      .parameter(0)
      .toEqualTypeOf<string>();
    expectTypeOf(expect(table).toBeInTheDocument()).toEqualTypeOf<void>();
    const assertion = expect(Promise.resolve(table)).resolves.toHaveAttribute('class');
    expectTypeOf(assertion).toEqualTypeOf<Promise<void>>();
    await assertion;
  });
});
