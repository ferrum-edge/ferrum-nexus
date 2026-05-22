# PR 0 Hardening Inventory

This inventory captures the baseline behavior that the first hardening phase
guards before adding summaries, docs rendering, search, cache, governance, and
pagination.

## Gateway Admin API call boundary

Normal portal reads should resolve from Nexus storage unless the endpoint is
explicitly about health, drift, import, refresh, or a mutation that changes
gateway state.

Current Edge-calling paths:

- `POST /api/provider/apis` validates the OpenAPI document locally, then calls
  `FerrumAdminClient.createApiSpec`. If the API is requestable, it also calls
  `upsertPlugin` for the access-control plugin.
- `PUT /api/provider/apis/:id/spec` validates the replacement spec locally,
  then calls `replaceApiSpec`. If the API is requestable, it refreshes the
  access-control plugin.
- `DELETE /api/provider/apis/:id` and
  `DELETE /api/admin/god-mode/apis/:id` call `deleteApiSpec`.
- `POST /api/admin/imports/api-spec` calls `getApiSpec` and `getApiSpecRaw`
  before creating the Nexus asset.
- `GET /api/admin/drift` and `POST /api/admin/drift/sync` call
  `listApiSpecs`.
- Credential create/rotate/finalize and access approval/revoke call consumer,
  credential, and ACL update methods on the Gateway Admin API.
- `/api/health` probes `health`.

Current Nexus-storage read paths:

- `GET /api/catalog/apis` lists `api_assets`.
- `GET /api/catalog/apis/:id` reads `api_assets` and provider user data.
- `GET /api/catalog/apis/:id/spec` reads the latest `api_spec_versions.raw_spec`.
- `GET /api/provider/apis` reads provider-owned `api_assets`.
- Admin users, settings, audit logs, email DLQ, mass email campaigns, and local
  API lists read Nexus storage.

## Existing OpenAPI protections

`server/src/api-publishing/oas.ts` currently rejects:

- malformed JSON/YAML;
- non-object documents;
- non-OpenAPI 3.x documents;
- missing or invalid `x-ferrum-proxy`;
- `x-ferrum-proxy` without any route target;
- external `$ref` URLs using `http://`, `https://`, or protocol-relative
  `//` forms.

These checks run before publish/replace calls reach the Gateway Admin API.

## Regression guardrails

The test helper in `server/src/test/helpers/ferrum-admin.ts` provides a
counting in-memory `FerrumAdminClient`. Tests can assert total calls or calls
for a specific method with:

```ts
assert.equal(ferrum.count('createApiSpec'), 1);
assert.equal(ferrum.count(), 0);
```

The route regression suite in
`server/src/test/publishing-catalog-routes.test.ts` verifies:

- provider publish persists an API asset and the submitted raw spec;
- provider spec replacement stores the new raw spec and updates metadata;
- catalog list/detail/raw spec routes make zero Gateway Admin API calls;
- invalid and unsafe OpenAPI uploads are rejected before any Edge mutation.

Run the PR 0 guardrails with:

```bash
npm run build --workspace shared
cd server
node --test --import tsx --test-name-pattern "publish|catalog|OpenAPI" src/**/*.test.ts
```
