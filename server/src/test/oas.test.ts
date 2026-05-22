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
  proxy_id: orders-proxy
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

test('extractMetadata rejects x-ferrum-proxy missing proxy_id', () => {
  const bad = `{
    "openapi": "3.0.0",
    "info": { "title": "x", "version": "1" },
    "paths": {},
    "x-ferrum-proxy": { "paths": ["/x"] }
  }`;
  assert.throws(() => extractMetadata(bad), /invalid_ferrum_proxy|proxy_id/i);
});

test('extractMetadata rejects external $ref URLs (SSRF guard)', () => {
  const bad = `{
    "openapi": "3.0.0",
    "info": { "title": "x", "version": "1" },
    "paths": {},
    "x-ferrum-proxy": { "proxy_id": "p", "paths": ["/x"] },
    "components": {
      "schemas": {
        "Bad": { "$ref": "https://attacker.example/schema.json" }
      }
    }
  }`;
  assert.throws(() => extractMetadata(bad), /external_ref_forbidden|external \$ref/i);
});

test('extractMetadata rejects protocol-relative external $ref URLs', () => {
  const bad = `{
    "openapi": "3.0.0",
    "info": { "title": "x", "version": "1" },
    "paths": {},
    "x-ferrum-proxy": { "proxy_id": "p", "paths": ["/x"] },
    "components": {
      "schemas": {
        "Bad": { "$ref": "//attacker.example/schema.json" }
      }
    }
  }`;
  assert.throws(() => extractMetadata(bad), /external_ref_forbidden|external \$ref/i);
});

test('extractMetadata rejects malformed OpenAPI documents', () => {
  assert.throws(() => extractMetadata('{ "openapi": "3.0.0",'), /Failed to parse/);
});

test('extractMetadata rejects unsupported OpenAPI versions', () => {
  const bad = `{
    "swagger": "2.0",
    "info": { "title": "x", "version": "1" },
    "paths": {},
    "x-ferrum-proxy": { "proxy_id": "p", "paths": ["/x"] }
  }`;
  assert.throws(() => extractMetadata(bad), /Only OpenAPI 3\.x is supported/);
});

test('extractMetadata rejects non-object documents', () => {
  assert.throws(() => extractMetadata('[]'), /OpenAPI document must be an object/);
});

test('slugify produces URL-safe slugs', () => {
  assert.equal(slugify('Orders API v1.2'), 'orders-api-v1-2');
  assert.equal(slugify('  ' + 'hello   world '), 'hello-world');
});
