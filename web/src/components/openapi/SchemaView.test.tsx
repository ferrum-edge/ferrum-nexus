import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createRenderBudget, MAX_PAGE_NODES, SchemaView } from './SchemaView';
import { OpenApiView } from './OpenApiView';
import type { SpecNode } from './parse';

afterEach(cleanup);

/**
 * A document that is only a few KB but expands combinatorially: each level has
 * `breadth` properties, every one of which `$ref`s the next level. Rendering it
 * naively is O(breadth^levels) nodes.
 */
function fanOutDoc(levels: number, breadth: number): SpecNode {
  const schemas: Record<string, unknown> = {};
  for (let level = 0; level < levels; level += 1) {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < breadth; index += 1) {
      properties[`p${index}`] =
        level === levels - 1 ? { type: 'string' } : { $ref: `#/components/schemas/L${level + 1}` };
    }
    schemas[`L${level}`] = { type: 'object', properties };
  }
  return { components: { schemas } } as SpecNode;
}

describe('SchemaView', () => {
  it('renders object properties with their types', () => {
    const doc = { components: { schemas: {} } } as SpecNode;
    render(
      <SchemaView
        doc={doc}
        budget={createRenderBudget()}
        schema={{
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' }, total: { type: 'number' } },
        }}
      />,
    );
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('required')).toBeInTheDocument();
    expect(screen.getByText('string <uuid>')).toBeInTheDocument();
    expect(screen.getByText('number')).toBeInTheDocument();
  });

  it('marks a self-referential $ref as circular instead of recursing', () => {
    const doc = {
      components: {
        schemas: {
          Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } },
        },
      },
    } as SpecNode;
    render(
      <SchemaView
        doc={doc}
        budget={createRenderBudget()}
        schema={{ $ref: '#/components/schemas/Node' }}
      />,
    );
    expect(screen.getByText(/circular →/)).toBeInTheDocument();
  });

  it('bounds a combinatorial fan-out document instead of hanging', () => {
    // 14 levels x 8 properties = ~5 KB of JSON but 8^13 nodes unbounded.
    const doc = fanOutDoc(14, 8);
    const started = Date.now();
    const { container } = render(
      <SchemaView
        doc={doc}
        budget={createRenderBudget()}
        schema={{ $ref: '#/components/schemas/L0' }}
      />,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    // The budget stops the traversal well before the document is exhausted.
    expect(container.querySelectorAll('code').length).toBeLessThan(20_000);
    expect(screen.getAllByText(/download the specification/).length).toBeGreaterThan(0);
  });

  it('stops a pure $ref alias chain at the depth limit', () => {
    // Each schema is *directly* a $ref to the next, with no object in between,
    // so nothing but the $ref branch itself can charge for the nesting.
    const schemas: Record<string, unknown> = {};
    for (let level = 0; level < 40; level += 1) {
      schemas[`A${level}`] =
        level === 39 ? { type: 'string' } : { $ref: `#/components/schemas/A${level + 1}` };
    }
    const doc = { components: { schemas } } as SpecNode;
    render(
      <SchemaView
        doc={doc}
        budget={createRenderBudget()}
        schema={{ $ref: '#/components/schemas/A0' }}
      />,
    );
    expect(screen.getByText('…nested further')).toBeInTheDocument();
  });
});

describe('OpenApiView operation paging', () => {
  /** A spec declaring `count` trivial GET operations. */
  function manyOperationsSpec(count: number): string {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < count; index += 1) {
      paths[`/resource-${index}`] = {
        get: { summary: `Operation ${index}`, responses: { '200': { description: 'ok' } } },
      };
    }
    return JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Huge API', version: '1.0.0' },
      paths,
    });
  }

  it('mounts only a page of operations for a huge document', () => {
    const started = Date.now();
    render(<OpenApiView text={manyOperationsSpec(5_000)} />);
    expect(Date.now() - started).toBeLessThan(10_000);

    // The header still reports the true total.
    expect(screen.getByText('5000 operations')).toBeInTheDocument();
    // …but nowhere near that many cards are mounted.
    expect(screen.getByText(/Showing 200 of 5000 operations/)).toBeInTheDocument();
    expect(screen.queryByText('Operation 4999')).not.toBeInTheDocument();
  });

  it('reveals another page on demand', () => {
    render(<OpenApiView text={manyOperationsSpec(500)} />);
    expect(screen.queryByText('Operation 250')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Show 200 more/ }));
    expect(screen.getByText('Operation 250')).toBeInTheDocument();
    expect(screen.getByText(/Showing 400 of 500 operations/)).toBeInTheDocument();
  });

  it('shows no paging control for an ordinary spec', () => {
    render(<OpenApiView text={manyOperationsSpec(3)} />);
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
    expect(screen.getByText('Operation 2')).toBeInTheDocument();
  });
});

/** Both budget cases mount tens of thousands of jsdom nodes on purpose. */
const BUDGET_TEST_TIMEOUT_MS = 30_000;

describe('OpenApiView page budget', () => {
  /**
   * One operation, one response, `mediaTypes` media types — each pointing at a
   * schema wide enough to exhaust the whole page allowance on its own. The
   * document is a few KB; only its expansion is large, and nothing the server
   * counts (paths, operations, bytes) sees any of it.
   */
  function wideMediaTypeSpec(mediaTypes: number, properties: number): string {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < properties; index += 1) {
      wide[`property_${index}`] = { type: 'string' };
    }
    const content: Record<string, unknown> = {};
    for (let index = 0; index < mediaTypes; index += 1) {
      content[`application/vnd.x${index}+json`] = { schema: { $ref: '#/components/schemas/Wide' } };
    }
    return JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Fan-out API', version: '1.0.0' },
      paths: {
        '/things': {
          get: { summary: 'Fan out', responses: { '200': { description: 'ok', content } } },
          post: { summary: 'Fan out too', responses: { '200': { description: 'ok', content } } },
        },
      },
      components: { schemas: { Wide: { type: 'object', properties: wide } } },
    });
  }

  it(
    'spends one allowance across every media type of an expanded operation',
    () => {
      const { container } = render(<OpenApiView text={wideMediaTypeSpec(50, MAX_PAGE_NODES)} />);

      const started = Date.now();
      fireEvent.click(screen.getAllByRole('button', { expanded: false })[0] as HTMLElement);
      expect(Date.now() - started).toBeLessThan(10_000);

      // The first media type spends the page allowance; the other 49 are never
      // walked, which is what a per-call budget used to let them do.
      expect(screen.getAllByText(/download the specification/).length).toBeGreaterThan(0);
      expect(screen.getByText('application/vnd.x0+json')).toBeInTheDocument();
      expect(screen.queryByText('application/vnd.x49+json')).not.toBeInTheDocument();

      // A schema row costs a handful of elements, so one allowance is tens of
      // thousands of them — against the ~1.2 million that 50 fresh allowances,
      // one per media type, used to mount.
      expect(container.querySelectorAll('code').length).toBeLessThan(MAX_PAGE_NODES * 4);
      expect(container.querySelectorAll('*').length).toBeLessThan(MAX_PAGE_NODES * 10);
    },
    BUDGET_TEST_TIMEOUT_MS,
  );

  it(
    'keeps two expanded operations inside one page allowance between them',
    () => {
      const { container } = render(<OpenApiView text={wideMediaTypeSpec(2, MAX_PAGE_NODES)} />);

      const buttons = screen.getAllByRole('button', { expanded: false });
      expect(buttons).toHaveLength(2);
      fireEvent.click(buttons[0] as HTMLElement);
      const oneOpen = container.querySelectorAll('*').length;

      fireEvent.click(screen.getAllByRole('button', { expanded: false })[0] as HTMLElement);
      const twoOpen = container.querySelectorAll('*').length;

      // The allowance is divided between the expanded cards rather than handed to
      // each of them, so opening the second one does not double the page.
      expect(twoOpen).toBeLessThan(oneOpen * 1.5);
      expect(twoOpen).toBeLessThan(MAX_PAGE_NODES * 10);
      expect(screen.getAllByText(/download the specification/).length).toBeGreaterThan(0);
    },
    BUDGET_TEST_TIMEOUT_MS,
  );
});
