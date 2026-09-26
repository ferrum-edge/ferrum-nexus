/**
 * Parameter inheritance and whole-object Reference Objects in the documentation
 * renderer: an operation parameter overrides its path-level namesake by
 * `(in, name)`, and a `$ref`'d parameter, request body or response renders the
 * object it names — or says plainly that it could not be followed.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenApiView } from './OpenApiView';
import { parseSpecText, type SpecEntry, type SpecOperation } from './parse';

afterEach(cleanup);

const OVERRIDE_SPEC = `
openapi: 3.0.3
info: { title: Parameter inheritance, version: '1' }
paths:
  /items:
    parameters:
      - name: limit
        in: query
        required: true
        schema: { type: integer }
    get:
      parameters:
        - name: limit
          in: query
          required: false
          schema: { type: integer }
      responses:
        '200': { description: ok }
`;

const COMPONENTS_SPEC = `
openapi: 3.0.3
info: { title: Reusable components, version: '1' }
paths:
  /items:
    post:
      parameters:
        - $ref: '#/components/parameters/Tenant'
      requestBody:
        $ref: '#/components/requestBodies/Payload'
      responses:
        '200':
          $ref: '#/components/responses/Ok'
components:
  parameters:
    Tenant:
      name: tenant_id
      in: header
      required: true
      schema: { type: string }
  requestBodies:
    Payload:
      required: true
      description: Required payload description
      content:
        application/json:
          schema: { type: object, properties: { input: { type: string } } }
  responses:
    Ok:
      description: Expected result description
      content:
        application/json:
          schema: { type: object, properties: { result: { type: string } } }
`;

/** The only operation of a document that must parse. */
function onlyOperation(document: unknown): SpecOperation {
  const text = typeof document === 'string' ? document : JSON.stringify(document);
  const result = parseSpecText(text);
  if (!result.ok) throw new Error(result.error);
  const operation = result.spec.groups[0]?.operations[0];
  if (!operation) throw new Error('no operation');
  return operation;
}

/** A compact view of an entry: the named fields of a resolved one, or why it is not. */
function describeEntry(entry: SpecEntry | null | undefined): unknown {
  if (!entry) return entry;
  if (!entry.resolved) return { unresolved: entry.ref, reason: entry.reason };
  const { name, in: location, required, description } = entry.node;
  return { name, in: location, required, description };
}

function jsonSpec(
  paths: Record<string, unknown>,
  components: Record<string, unknown> = {},
  openapi = '3.0.3',
): Record<string, unknown> {
  return { openapi, info: { title: 'Fixture', version: '1' }, paths, components };
}

const OK = { '200': { description: 'ok' } };

describe('parameter inheritance', () => {
  it('lets an operation parameter replace its path-level namesake', () => {
    const operation = onlyOperation(OVERRIDE_SPEC);
    expect(operation.parameters.map(describeEntry)).toEqual([
      { name: 'limit', in: 'query', required: false, description: undefined },
    ]);
  });

  it('renders one optional row for an overridden parameter', () => {
    render(<OpenApiView text={OVERRIDE_SPEC} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getAllByText('limit')).toHaveLength(1);
    expect(screen.getByText('optional')).toBeInTheDocument();
    expect(screen.queryByText('required')).not.toBeInTheDocument();
  });

  it('keeps inherited parameters and same-named ones in other locations', () => {
    const operation = onlyOperation(
      jsonSpec({
        '/items/{id}': {
          parameters: [
            { name: 'id', in: 'path', required: true },
            { name: 'trace', in: 'header', description: 'path-level' },
          ],
          get: {
            parameters: [
              { name: 'id', in: 'query', description: 'a filter, not the path id' },
              { name: 'Trace', in: 'header', description: 'operation-level' },
            ],
            responses: OK,
          },
        },
      }),
    );
    // `id` in the path and `id` in the query are two parameters; header names
    // compare case-insensitively, so `Trace` overrides `trace`.
    expect(operation.parameters.map(describeEntry)).toEqual([
      { name: 'id', in: 'path', required: true, description: undefined },
      { name: 'id', in: 'query', required: undefined, description: 'a filter, not the path id' },
      { name: 'Trace', in: 'header', required: undefined, description: 'operation-level' },
    ]);
  });

  it('overrides a referenced path-level parameter with an inline one, and the reverse', () => {
    const operation = onlyOperation(
      jsonSpec(
        {
          '/items': {
            parameters: [
              { $ref: '#/components/parameters/Tenant' },
              { name: 'limit', in: 'query', required: true },
            ],
            get: {
              parameters: [
                { name: 'tenant_id', in: 'header', required: false },
                { $ref: '#/components/parameters/Limit' },
              ],
              responses: OK,
            },
          },
        },
        {
          parameters: {
            Tenant: { name: 'tenant_id', in: 'header', required: true },
            Limit: { name: 'limit', in: 'query', description: 'shared limit' },
          },
        },
      ),
    );
    expect(operation.parameters.map(describeEntry)).toEqual([
      { name: 'tenant_id', in: 'header', required: false, description: undefined },
      { name: 'limit', in: 'query', required: undefined, description: 'shared limit' },
    ]);
  });

  it('never merges away a parameter whose reference cannot be followed', () => {
    const operation = onlyOperation(
      jsonSpec({
        '/items': {
          parameters: [{ $ref: '#/components/parameters/Missing' }],
          get: { parameters: [{ name: 'limit', in: 'query' }], responses: OK },
        },
      }),
    );
    expect(operation.parameters.map(describeEntry)).toEqual([
      { unresolved: '#/components/parameters/Missing', reason: 'missing' },
      { name: 'limit', in: 'query', required: undefined, description: undefined },
    ]);
  });
});

describe('reusable component references', () => {
  it('resolves referenced parameters, request bodies and responses', () => {
    const operation = onlyOperation(COMPONENTS_SPEC);
    expect(operation.parameters.map(describeEntry)).toEqual([
      { name: 'tenant_id', in: 'header', required: true, description: undefined },
    ]);
    expect(describeEntry(operation.requestBody)).toMatchObject({
      required: true,
      description: 'Required payload description',
    });
    expect(operation.responses.map(([status]) => status)).toEqual(['200']);
    expect(describeEntry(operation.responses[0]?.[1])).toMatchObject({
      description: 'Expected result description',
    });
  });

  it('renders the referenced header, request body and response', () => {
    render(<OpenApiView text={COMPONENTS_SPEC} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('tenant_id')).toBeInTheDocument();
    expect(screen.getByText('header')).toBeInTheDocument();
    expect(screen.queryByText('optional')).not.toBeInTheDocument();
    // One for the header parameter, one for the request body.
    expect(screen.getAllByText('required')).toHaveLength(2);
    expect(screen.getByText('Required payload description')).toBeInTheDocument();
    expect(screen.getByText('input')).toBeInTheDocument();
    expect(screen.getByText('Expected result description')).toBeInTheDocument();
    expect(screen.getByText('result')).toBeInTheDocument();
  });

  it('follows reference chains and escaped JSON pointers', () => {
    const operation = onlyOperation(
      jsonSpec(
        {
          '/items': {
            post: {
              parameters: [{ $ref: '#/components/parameters/a~1b~0c' }],
              requestBody: { $ref: '#/components/requestBodies/Alias' },
              responses: { '200': { $ref: '#/components/responses/With%20Space' } },
            },
          },
        },
        {
          parameters: { 'a/b~c': { name: 'escaped', in: 'query' } },
          requestBodies: {
            Alias: { $ref: '#/components/requestBodies/Real' },
            Real: { description: 'at the end of the chain', required: true },
          },
          responses: { 'With Space': { description: 'percent-decoded' } },
        },
      ),
    );
    expect(describeEntry(operation.parameters[0])).toMatchObject({ name: 'escaped' });
    expect(describeEntry(operation.requestBody)).toMatchObject({
      description: 'at the end of the chain',
      required: true,
    });
    expect(describeEntry(operation.responses[0]?.[1])).toMatchObject({
      description: 'percent-decoded',
    });
  });

  it('reports cycles, dangling, external, non-object and overlong references', () => {
    const chain: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) {
      chain[`R${index}`] = { $ref: `#/components/responses/R${index + 1}` };
    }
    chain.R40 = { description: 'too far away' };
    const operation = onlyOperation(
      jsonSpec(
        {
          '/items': {
            post: {
              parameters: [
                { $ref: '#/components/parameters/Self' },
                { $ref: '#/components/parameters/A' },
                { $ref: '#/components/parameters/Missing' },
                { $ref: 'common.yaml#/components/parameters/Tenant' },
                { $ref: '#/info/title' },
                { $ref: '#/components/parameters/__proto__' },
              ],
              requestBody: { $ref: '#/components/requestBodies/Loop' },
              responses: { '200': { $ref: '#/components/responses/R0' } },
            },
          },
        },
        {
          parameters: {
            Self: { $ref: '#/components/parameters/Self' },
            A: { $ref: '#/components/parameters/B' },
            B: { $ref: '#/components/parameters/A' },
          },
          requestBodies: { Loop: { $ref: '#/components/requestBodies/Loop' } },
          responses: chain,
        },
      ),
    );
    expect(operation.parameters.map(describeEntry)).toEqual([
      { unresolved: '#/components/parameters/Self', reason: 'cycle' },
      { unresolved: '#/components/parameters/A', reason: 'cycle' },
      { unresolved: '#/components/parameters/Missing', reason: 'missing' },
      { unresolved: 'common.yaml#/components/parameters/Tenant', reason: 'external' },
      { unresolved: '#/info/title', reason: 'missing' },
      { unresolved: '#/components/parameters/__proto__', reason: 'missing' },
    ]);
    expect(describeEntry(operation.requestBody)).toEqual({
      unresolved: '#/components/requestBodies/Loop',
      reason: 'cycle',
    });
    expect(describeEntry(operation.responses[0]?.[1])).toMatchObject({ reason: 'depth' });
  });

  it('renders an unresolved reference explicitly instead of an optional, unnamed row', () => {
    const spec = jsonSpec(
      {
        '/items': {
          post: {
            parameters: [{ $ref: '#/components/parameters/A' }],
            requestBody: { $ref: '#/components/requestBodies/Missing' },
            responses: { '200': { $ref: 'shared.yaml#/responses/Ok' } },
          },
        },
      },
      {
        parameters: {
          A: { $ref: '#/components/parameters/B' },
          B: { $ref: '#/components/parameters/A' },
        },
      },
    );
    render(<OpenApiView text={JSON.stringify(spec)} />);
    fireEvent.click(screen.getByRole('button', { expanded: false }));

    expect(screen.getByText('unresolved $ref #/components/parameters/A')).toBeInTheDocument();
    expect(screen.getByText('the reference chain is circular')).toBeInTheDocument();
    expect(
      screen.getByText('unresolved $ref #/components/requestBodies/Missing'),
    ).toBeInTheDocument();
    expect(screen.getByText('unresolved $ref shared.yaml#/responses/Ok')).toBeInTheDocument();
    expect(screen.getByText('external references are not followed')).toBeInTheDocument();
    expect(screen.queryByText('optional')).not.toBeInTheDocument();
  });

  it('applies description siblings of a $ref from OpenAPI 3.1 on, and ignores them before', () => {
    const paths = {
      '/items': {
        get: {
          responses: {
            '200': { $ref: '#/components/responses/Ok', description: 'sibling description' },
          },
        },
      },
    };
    const components = { responses: { Ok: { description: 'component description' } } };

    const legacy = onlyOperation(jsonSpec(paths, components, '3.0.3'));
    expect(describeEntry(legacy.responses[0]?.[1])).toMatchObject({
      description: 'component description',
    });

    const current = onlyOperation(jsonSpec(paths, components, '3.1.0'));
    expect(describeEntry(current.responses[0]?.[1])).toMatchObject({
      description: 'sibling description',
    });
  });
});
