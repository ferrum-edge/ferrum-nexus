import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SchemaView } from './SchemaView';
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
    render(<SchemaView doc={doc} schema={{ $ref: '#/components/schemas/Node' }} />);
    expect(screen.getByText(/circular →/)).toBeInTheDocument();
  });

  it('bounds a combinatorial fan-out document instead of hanging', () => {
    // 14 levels x 8 properties = ~5 KB of JSON but 8^13 nodes unbounded.
    const doc = fanOutDoc(14, 8);
    const started = Date.now();
    const { container } = render(
      <SchemaView doc={doc} schema={{ $ref: '#/components/schemas/L0' }} />,
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    // The budget stops the traversal well before the document is exhausted.
    expect(container.querySelectorAll('code').length).toBeLessThan(20_000);
    expect(screen.getAllByText('…truncated').length).toBeGreaterThan(0);
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
    render(<SchemaView doc={doc} schema={{ $ref: '#/components/schemas/A0' }} />);
    expect(screen.getByText('…nested further')).toBeInTheDocument();
  });
});
