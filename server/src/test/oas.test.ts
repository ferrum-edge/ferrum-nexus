import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractMetadata, slugify } from '../api-publishing/oas.js';

test('extractMetadata parses YAML and JSON specs', () => {
  const yaml = `
openapi: 3.0.0
info:
  title: Test API
  version: 1.2.3
  description: Sample
servers:
  - url: https://api.example.com
tags:
  - name: alpha
  - name: beta
paths:
  /things:
    get:
      summary: list
    post:
      summary: create
x-ferrum-proxy:
  paths:
    - /things
`;
  const meta = extractMetadata(yaml);
  assert.equal(meta.title, 'Test API');
  assert.equal(meta.version, '1.2.3');
  assert.deepEqual(meta.tags, ['alpha', 'beta']);
  assert.equal(meta.operationCount, 2);
  assert.equal(meta.rawContentType, 'application/yaml');
});

test('extractMetadata rejects missing x-ferrum-proxy', () => {
  const bad = `{
    "openapi": "3.0.0",
    "info": { "title": "x", "version": "1" },
    "paths": {}
  }`;
  assert.throws(() => extractMetadata(bad), /x-ferrum-proxy/);
});

test('extractMetadata rejects non-object documents', () => {
  assert.throws(() => extractMetadata('[]'), /OpenAPI document must be an object/);
});

test('slugify produces URL-safe slugs', () => {
  assert.equal(slugify('Orders API v1.2'), 'orders-api-v1-2');
  assert.equal(slugify('  ' + 'hello   world '), 'hello-world');
});
