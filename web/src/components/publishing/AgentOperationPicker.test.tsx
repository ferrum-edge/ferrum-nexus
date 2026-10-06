import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_SPEC_OPERATIONS,
  type ApiAgents,
  type SpecEnforcementLevel,
} from '@ferrum-nexus/shared';
import { AgentOperationPicker } from './AgentOperationPicker';

const SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Items', version: '1' },
  paths: {
    '/items': {
      get: { operationId: 'listItems', summary: 'List items' },
      head: { operationId: 'headItems' },
      post: { operationId: 'createItem', summary: 'Create an item' },
    },
  },
});

function Picker({
  enforcement = 'routes',
  spec = SPEC,
}: {
  enforcement?: SpecEnforcementLevel;
  spec?: string;
}): ReactElement {
  const [value, setValue] = useState<ApiAgents | null>(null);
  return (
    <>
      <AgentOperationPicker
        spec={spec}
        value={value}
        onChange={setValue}
        enforcement={enforcement}
        requestable
      />
      <output aria-label="Selected tools">{JSON.stringify(value)}</output>
    </>
  );
}

afterEach(cleanup);

describe('provider agent operation selection', () => {
  it('is off by default and cannot be enabled in docs-only mode', () => {
    render(<Picker enforcement="docs_only" />);
    expect(screen.getByLabelText('Available to AI agents')).not.toBeChecked();
    expect(screen.getByLabelText('Available to AI agents')).toBeDisabled();
  });

  it('cannot be enabled when Path Item references resolve past the operation cap', () => {
    // Every path shares one Path Item of two operations: one more than the
    // cap once resolved, though no path declares a method of its own.
    const paths: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_SPEC_OPERATIONS / 2; index += 1) {
      paths[`/items/${index}`] = { $ref: '#/components/pathItems/Item' };
    }
    const spec = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Items', version: '1' },
      paths,
      components: {
        pathItems: { Item: { get: { summary: 'Read' }, post: { summary: 'Write' } } },
      },
    });
    render(<Picker spec={spec} />);
    expect(screen.getByLabelText('Available to AI agents')).toBeDisabled();
  });

  it('preselects GET, requires an explicit destructive tick, and exposes editable labels', () => {
    render(<Picker />);
    fireEvent.click(screen.getByLabelText('Available to AI agents'));
    expect(screen.getByLabelText('Expose GET /items')).toBeChecked();
    expect(screen.getByLabelText('Expose POST /items')).not.toBeChecked();
    expect(screen.getByLabelText('Expose HEAD /items')).toBeDisabled();
    expect(screen.getByLabelText('Tool name for GET /items', { exact: false })).toHaveValue(
      'listItems',
    );
    fireEvent.click(screen.getByLabelText('Expose POST /items'));
    fireEvent.change(screen.getByLabelText('Tool name for POST /items', { exact: false }), {
      target: { value: 'create' },
    });
    fireEvent.change(screen.getByLabelText('Tool description for POST /items', { exact: false }), {
      target: { value: 'Create one item with confirmation' },
    });
    expect(screen.getByLabelText('Selected tools')).toHaveTextContent(
      'Create one item with confirmation',
    );
    expect(screen.getByLabelText('Selected tools')).toHaveTextContent('"name":"create"');
    fireEvent.click(screen.getByLabelText('Expose GET /items'));
    expect(screen.getByLabelText('Selected tools')).not.toHaveTextContent('listItems');
    fireEvent.click(screen.getByLabelText('Available to AI agents'));
    expect(screen.getByLabelText('Selected tools')).toHaveTextContent('null');
  });
});
