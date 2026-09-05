import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenApiView } from './OpenApiView';
import { parseSpecText, resolveRef, UNRESOLVED_REF } from './parse';

const YAML_SPEC = `
openapi: 3.0.3
info:
  title: Billing API
  version: 2.1.0
  description: Invoices and payments.
servers:
  - url: https://api.example.com/v2
    description: Production
tags:
  - name: Invoices
    description: Invoice operations
paths:
  /invoices:
    get:
      tags: [Invoices]
      summary: List invoices
      operationId: listInvoices
      parameters:
        - name: page_size
          in: query
          required: false
          description: Rows per page
          schema:
            type: integer
            format: int32
      responses:
        '200':
          description: A page of invoices
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Invoice'
components:
  schemas:
    Invoice:
      type: object
      required: [id]
      properties:
        id:
          type: string
        parent:
          $ref: '#/components/schemas/Invoice'
`;

const JSON_SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Ledger API', version: '0.9.0' },
  paths: {
    '/entries': {
      post: { summary: 'Create an entry', responses: { '201': { description: 'Created' } } },
    },
  },
});

afterEach(cleanup);

function multiTagSpec(count: number, includeLastGroup = false): string {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) {
    paths[`/resource-${index}`] = {
      get: { tags: ['A', 'B'], responses: { '200': { description: 'ok' } } },
    };
  }
  if (includeLastGroup) {
    paths['/last-group'] = {
      get: { tags: ['C'], responses: { '200': { description: 'ok' } } },
    };
  }
  return JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Multi-tag API', version: '1.0.0' },
    paths,
  });
}

describe('OpenApiView multi-tag paging', () => {
  it('reveals a final group after 100 operations appearing under both A and B', () => {
    const { container } = render(<OpenApiView text={multiTagSpec(100, true)} />);

    expect(screen.getByText('101 operations')).toBeInTheDocument();
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(200);
    expect(screen.getByText('Showing 200 of 201 operation entries.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'C' })).not.toBeInTheDocument();
    expect(screen.queryByText('/last-group')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 more' }));

    expect(screen.getByRole('heading', { name: 'C' })).toBeInTheDocument();
    expect(screen.getByText('/last-group')).toBeInTheDocument();
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(201);
    expect(screen.queryByRole('button', { name: /Show .* more/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });

  it.each([99, 100, 101, 250])('pages all tag entries for %i multi-tag operations', (count) => {
    const { container } = render(<OpenApiView text={multiTagSpec(count)} />);
    const totalEntries = count * 2;
    let shown = Math.min(200, totalEntries);

    expect(screen.getByText(`${count} operations`)).toBeInTheDocument();
    expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(shown);

    while (shown < totalEntries) {
      expect(
        screen.getByText(`Showing ${shown} of ${totalEntries} operation entries.`),
      ).toBeInTheDocument();
      const remaining = totalEntries - shown;
      expect(remaining).toBeGreaterThan(0);
      expect(screen.queryByRole('button', { name: /Show -\d+ more/ })).not.toBeInTheDocument();
      const nextPage = Math.min(200, remaining);
      fireEvent.click(screen.getByRole('button', { name: `Show ${nextPage} more` }));
      shown += nextPage;
      expect(container.querySelectorAll('button[aria-expanded]')).toHaveLength(shown);
    }

    expect(screen.getByRole('heading', { name: 'A' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'B' })).toBeInTheDocument();
    const expectedPaths = Array.from({ length: count }, (_, index) => `/resource-${index}`);
    const renderedPaths = Array.from(
      container.querySelectorAll('button code'),
      (el) => el.textContent,
    );
    expect(renderedPaths).toEqual([...expectedPaths, ...expectedPaths]);
    expect(screen.queryByRole('button', { name: /Show .* more/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });
});

describe('OpenApiView', () => {
  it('renders info, servers and tag-grouped operations from a YAML document', () => {
    render(<OpenApiView text={YAML_SPEC} />);

    expect(screen.getByText('Billing API')).toBeInTheDocument();
    expect(screen.getByText('v2.1.0')).toBeInTheDocument();
    expect(screen.getByText('OpenAPI 3.0.3')).toBeInTheDocument();
    expect(screen.getByText('1 operation')).toBeInTheDocument();
    expect(screen.getByText('https://api.example.com/v2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
    expect(screen.getByText('get')).toBeInTheDocument();
    expect(screen.getByText('/invoices')).toBeInTheDocument();
    expect(screen.getByText('List invoices')).toBeInTheDocument();
  });

  it('expands an operation to show parameters and $ref-resolved response schemas', () => {
    render(<OpenApiView text={YAML_SPEC} />);

    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('Parameters')).toBeInTheDocument();
    expect(screen.getByText('page_size')).toBeInTheDocument();
    expect(screen.getByText('query')).toBeInTheDocument();
    expect(screen.getByText('Responses')).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();
    // The $ref is resolved to its schema, whose own self-reference is guarded.
    expect(screen.getAllByText('Invoice').length).toBeGreaterThan(0);
    expect(screen.getByText('id')).toBeInTheDocument();
    expect(screen.getByText('circular → Invoice')).toBeInTheDocument();
  });

  it('renders a JSON document as well as YAML', () => {
    render(<OpenApiView text={JSON_SPEC} />);

    expect(screen.getByText('Ledger API')).toBeInTheDocument();
    expect(screen.getByText('post')).toBeInTheDocument();
    expect(screen.getByText('/entries')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Untagged' })).toBeInTheDocument();
  });

  it('shows an error panel instead of crashing on a malformed document', () => {
    render(<OpenApiView text={'openapi: [3.0.0\n  bad: : yaml'} />);

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('This specification could not be rendered')).toBeInTheDocument();
  });

  it('rejects documents that are not OpenAPI', () => {
    render(<OpenApiView text={'just: a mapping'} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('reports an empty document', () => {
    render(<OpenApiView text="   " />);
    expect(screen.getByText('The specification is empty.')).toBeInTheDocument();
  });
});

describe('parseSpecText', () => {
  it('flattens path-level parameters ahead of operation-level ones', () => {
    const result = parseSpecText(`
openapi: 3.0.0
info: { title: T, version: '1' }
paths:
  /a/{id}:
    parameters:
      - name: id
        in: path
        required: true
    get:
      parameters:
        - name: verbose
          in: query
      responses: { '200': { description: ok } }
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const operation = result.spec.groups[0]?.operations[0];
    expect(operation?.parameters.map((parameter) => parameter.name)).toEqual(['id', 'verbose']);
  });

  it('resolves local refs and flags unresolvable ones', () => {
    const result = parseSpecText(JSON_SPEC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resolveRef(result.spec.doc, '#/info')).toMatchObject({ title: 'Ledger API' });
    expect(resolveRef(result.spec.doc, '#/components/schemas/Missing')).toBe(UNRESOLVED_REF);
    expect(resolveRef(result.spec.doc, 'https://example.com/spec.yaml#/Pet')).toBe(UNRESOLVED_REF);
  });
});
