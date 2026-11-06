/**
 * What a spec-change notice says (issue #447): removed operations first, a
 * capped list, plain words for an `info`-only change, and the caveat kept.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_SPEC_CHANGE_TEXT,
  SPEC_CHANGE_NOTICE_NAMED,
  emptySpecChangeReport,
  type ApiSpecChangeEntry,
  type SpecChange,
  type SpecChangeReport,
} from '@ferrum-nexus/shared';

import {
  BREAKING_TITLE_MARK,
  INCOMPLETE_TITLE_MARK,
  agentToolsRenamedText,
  inertText,
  rewrittenNotice,
  specChangeEmailLine,
  specChangeIsNews,
  summarizeSpecChange,
} from './spec-change-notices.js';
import { compareSpecRevisions } from './spec-changes.js';

const FOUR_ADDED_SUMMARY =
  /^4 operations added, 1 changed, 1 removed\. 7 changes in all, 2 breaking\. /;
const CHANGE_DOES_NOT_LIST = /a change it does not list can still affect you\.$/;
const REMOVED_DELETE_ORDERS_ID = /Removed: DELETE \/orders\/\{id\}.*; GET \/a: /;
const CAN_STILL_AFFECT_YOU = /can still affect you\.$/;
const EARLIER_REVISION_SINCE_YOU =
  /An earlier revision since you last read included breaking changes/;
const EARLIER_REVISIONS_SINCE_YOU =
  /Earlier revisions since you last read are on the Changes tab too\.$/;
const ONE_ADDED_SUMMARY = /^1 operation added\. 1 change in all, 0 breaking\. /;
const ONLY_VERSION_DESCRIPTION_CHANGED = /^Only its version and description changed\. /;
const ONLY_TITLE_VERSION_DESCRIPTION = /^Only its title, version and description changed\. /;
const VERSION_CHANGED = /^Its version changed\. /;
const COVERS_THEM_USE_THEM = /covers them\. To use them again, request them on your /;
const AND_ONE_MORE_RENAMED = / and 1 more\)\. An explicit tool approval no longer covers them /;
const COMPARISON_INCOMPLETE = /The comparison was incomplete/;
const FOUND_NO_DIFFERENCE = /found no difference/;
const ONLY_ITS = /Only its/;
const VERSION_CHANGED_SENTENCE = /Its version changed\./;
const COULD_NOT_FULLY_COMPARED = /could not be fully compared/;
const POSSIBLY_BREAKING = /possibly breaking/;
const URL_SCHEME_SLASHES = /https?:[/\\]{2}/;
const LINE_BREAK = /[\r\n]/;

function change(overrides: Partial<SpecChange>): SpecChange {
  return {
    kind: 'operation_added',
    severity: 'non_breaking',
    operation: { method: 'GET', path: '/orders' },
    section: 'operation',
    location: null,
    schema_path: null,
    from: null,
    to: null,
    ...overrides,
  };
}

function entry(
  report: Partial<SpecChangeReport>,
  overrides: Partial<ApiSpecChangeEntry> = {},
): ApiSpecChangeEntry {
  return {
    id: 'change-1',
    api_id: 'api-1',
    revision_id: 'revision-2',
    previous_revision_id: 'revision-1',
    kind: 'update',
    version: '2.0.0',
    previous_version: '1.0.0',
    report: { ...emptySpecChangeReport(), changed: true, ...report },
    created_at: '2026-09-30T12:00:00.000Z',
    ...overrides,
  };
}

const counts = emptySpecChangeReport().counts;

describe('spec change notices', () => {
  it('names removed operations first, then caps the list', () => {
    const notice = summarizeSpecChange(
      'Billing',
      entry({
        changes: [
          change({
            kind: 'parameter_added',
            severity: 'breaking',
            operation: { method: 'GET', path: '/a' },
            section: 'parameter',
            location: 'query limit',
            to: 'required',
          }),
          change({
            kind: 'operation_removed',
            severity: 'breaking',
            operation: { method: 'DELETE', path: '/orders/{id}' },
          }),
          change({ operation: { method: 'GET', path: '/b' } }),
          change({ operation: { method: 'GET', path: '/c' } }),
          change({ operation: { method: 'GET', path: '/d' } }),
          change({ operation: { method: 'GET', path: '/e' } }),
        ],
        counts: {
          ...counts,
          breaking: 2,
          non_breaking: 5,
          operations_added: 4,
          operations_changed: 1,
          operations_removed: 1,
        },
        truncated: true,
      }),
    );
    assert.equal(notice.title, 'Billing spec updated to 2.0.0 (breaking changes)');
    assert.equal(notice.breaking, true);
    assert.equal(notice.headline, 'updated to 2.0.0');
    assert.deepEqual(notice.lines, [
      'Removed: DELETE /orders/{id} (requests to removed operations may now fail)',
      'GET /a: Parameter query limit added (required)',
      'GET /b: Operation added',
      'GET /c: Operation added',
      'GET /d: Operation added',
      'and 2 more changes',
    ]);
    assert.equal(notice.lines.length, SPEC_CHANGE_NOTICE_NAMED + 1);
    assert.match(notice.summary, FOUR_ADDED_SUMMARY);
    assert.match(notice.summary, CHANGE_DOES_NOT_LIST);
    assert.match(notice.body, REMOVED_DELETE_ORDERS_ID);
    assert.match(notice.body, CAN_STILL_AFFECT_YOU);
  });

  it('keeps a rewritten notice marked breaking once an earlier revision was', () => {
    const harmless = summarizeSpecChange(
      'Billing',
      entry({ changes: [change({})], counts: { ...counts, non_breaking: 1, operations_added: 1 } }),
    );
    assert.equal(harmless.breaking, false);
    const kept = rewrittenNotice(harmless, true);
    assert.equal(kept.title, `Billing spec updated to 2.0.0${BREAKING_TITLE_MARK}`);
    assert.match(kept.body, EARLIER_REVISION_SINCE_YOU);
    const plain = rewrittenNotice(harmless, false);
    assert.equal(plain.title, 'Billing spec updated to 2.0.0');
    assert.match(plain.body, EARLIER_REVISIONS_SINCE_YOU);
  });

  it('labels a rollback', () => {
    const notice = summarizeSpecChange(
      'Billing',
      entry(
        {
          changes: [change({})],
          counts: { ...counts, non_breaking: 1, operations_added: 1 },
        },
        { kind: 'rollback', version: '1.0.0' },
      ),
    );
    assert.equal(notice.title, 'Billing spec rolled back to 1.0.0');
    assert.match(notice.summary, ONE_ADDED_SUMMARY);
  });

  it('says so plainly when only the metadata changed', () => {
    const two = summarizeSpecChange('Billing', entry({ info_changes: ['version', 'description'] }));
    assert.match(two.summary, ONLY_VERSION_DESCRIPTION_CHANGED);
    assert.deepEqual(two.lines, []);
    const three = summarizeSpecChange(
      'Billing',
      entry({ info_changes: ['title', 'version', 'description'] }),
    );
    assert.match(three.summary, ONLY_TITLE_VERSION_DESCRIPTION);
  });

  it('names agent tools whose definition changed, even with no structural change', () => {
    const one = summarizeSpecChange('Billing', entry({ agent_tools_changed: ['list_orders'] }));
    assert.equal(
      one.summary,
      'The definition of 1 agent tool changed (list_orders). An explicit tool approval no ' +
        "longer covers it. To use it again, request it on your existing grant from the API's " +
        'catalog page: your current access stays in place while the provider reviews the ' +
        'request. This compares the structure of the two documents, so a change it does not ' +
        'list can still affect you.',
    );
    const names = Array.from({ length: SPEC_CHANGE_NOTICE_NAMED + 2 }, (_, i) => `tool_${i}`);
    const many = summarizeSpecChange(
      'Billing',
      entry({ info_changes: ['version'], agent_tools_changed: names }),
    );
    assert.match(many.summary, VERSION_CHANGED);
    assert.match(
      many.summary,
      new RegExp(`${names.length} agent tools changed \\(.*tool_0.* and 2 more\\)`),
    );
    assert.match(many.summary, COVERS_THEM_USE_THEM);
  });

  it('names renamed agent tools with their new names, bounded like other lists', () => {
    assert.equal(
      agentToolsRenamedText([['list_orders', 'orders_list']]),
      'The provider renamed 1 agent tool (list_orders to orders_list). An explicit tool ' +
        'approval no longer covers it under the new name. To use it again, request it on your ' +
        "existing grant from the API's catalog page: your current access stays in place while " +
        'the provider reviews the request.',
    );
    const pairs: [string, string][] = [];
    for (let i = 0; i <= SPEC_CHANGE_NOTICE_NAMED; i += 1) pairs.push([`old_${i}`, `new_${i}`]);
    const text = agentToolsRenamedText(pairs);
    assert.match(text, new RegExp(`renamed ${pairs.length} agent tools \\(old_0 to new_0, `));
    assert.match(text, AND_ONE_MORE_RENAMED);
  });

  it('says when the comparison was incomplete', () => {
    const notice = summarizeSpecChange(
      'Billing',
      entry({
        complete: false,
        changes: [change({})],
        counts: { ...counts, non_breaking: 1, operations_added: 1 },
      }),
    );
    assert.match(notice.summary, COMPARISON_INCOMPLETE);
  });

  it('sends a comparison that ran out of budget at any stage as possibly breaking', () => {
    type Doc = Record<string, unknown>;
    const doc = (paths: Doc, components: Doc = {}): Doc => ({
      openapi: '3.1.0',
      info: { title: 'Orders', version: '1.0.0' },
      paths,
      components,
    });
    const many = (count: number, item: (index: number) => Doc): Doc =>
      Object.fromEntries(Array.from({ length: count }, (_, index) => [`/p${index}`, item(index)]));
    const shared = (parameters: number): Doc => ({
      pathItems: {
        Shared: {
          parameters: Array.from({ length: parameters }, () => ({ name: 'id', in: 'query' })),
          get: { parameters: [{ name: 'id', in: 'query' }], responses: { '200': {} } },
        },
      },
    });
    const viaRef = (): Doc => ({ $ref: '#/components/pathItems/Shared' });
    const stages: [string, Doc, Doc, number][] = [
      // Following references while the operations are discovered.
      ['discovery', doc(many(400, viaRef), shared(1)), doc(many(400, viaRef), shared(1)), 300],
      // Comparing the parameters of an operation present on both sides.
      [
        'parameters',
        doc(many(4, viaRef), shared(5_000)),
        doc(many(4, viaRef), shared(5_000)),
        9_000,
      ],
      // Naming operations removed, after the comparisons.
      ['removals', doc(many(200, () => ({ get: { responses: { '200': {} } } }))), doc({}), 50],
    ];
    for (const [stage, before, after, unitLimit] of stages) {
      const report = compareSpecRevisions(before, after, { unitLimit });
      assert.equal(report.complete, false, stage);
      assert.equal(specChangeIsNews(report), true, `${stage}: never withheld as no change`);
      const notice = summarizeSpecChange('Billing', entry(report));
      assert.equal(notice.breaking, true, `${stage}: travels the breaking path`);
      assert.ok(
        notice.title.endsWith(BREAKING_TITLE_MARK) || notice.title.endsWith(INCOMPLETE_TITLE_MARK),
        `${stage}: ${notice.title}`,
      );
      assert.doesNotMatch(notice.summary, FOUND_NO_DIFFERENCE, stage);
    }

    // Only a complete comparison that found nothing is withheld.
    const same = doc({ '/x': { get: { responses: { '200': {} } } } });
    const unchanged = compareSpecRevisions(same, structuredClone(same));
    assert.equal(unchanged.complete, true);
    assert.equal(specChangeIsNews(unchanged), false);
  });

  it('warns about an incomplete comparison even when only info changed', () => {
    const notice = summarizeSpecChange(
      'Billing',
      entry({ complete: false, changed: true, info_changes: ['version'] }),
    );
    assert.doesNotMatch(notice.summary, ONLY_ITS);
    assert.match(notice.summary, VERSION_CHANGED_SENTENCE);
    assert.match(notice.summary, COMPARISON_INCOMPLETE);
    assert.equal(notice.breaking, true);
  });

  it('keeps an earlier incomplete comparison in a rewritten notice', () => {
    const harmless = summarizeSpecChange(
      'Billing',
      entry({ changed: true, info_changes: ['version'] }),
    );
    const rewritten = rewrittenNotice(harmless, 'incomplete');
    assert.ok(rewritten.title.endsWith(INCOMPLETE_TITLE_MARK), rewritten.title);
    assert.match(rewritten.body, COULD_NOT_FULLY_COMPARED);
    // Breaking outranks it, replacing the incomplete mark.
    const incomplete = summarizeSpecChange('Billing', entry({ complete: false, changed: false }));
    const upgraded = rewrittenNotice(incomplete, true);
    assert.ok(upgraded.title.endsWith(BREAKING_TITLE_MARK), upgraded.title);
    assert.ok(!upgraded.title.includes(INCOMPLETE_TITLE_MARK), upgraded.title);
  });

  it('marks an incomplete comparison that named nothing as possibly breaking', () => {
    const notice = summarizeSpecChange('Billing', entry({ complete: false, changed: false }));
    assert.equal(notice.breaking, true);
    assert.ok(notice.title.endsWith(INCOMPLETE_TITLE_MARK), notice.title);
    assert.match(notice.summary, COMPARISON_INCOMPLETE);
    assert.match(notice.summary, POSSIBLY_BREAKING);
  });

  it('breaks up anything a mail client would turn into a link', () => {
    assert.equal(
      specChangeEmailLine('GET /go/https://evil.example/x: Operation added'),
      '- GET /go/https[:]//evil.example/x: Operation added',
    );
    // The backslash spelling, which mail clients and the portal's own link
    // check both read as a URL too.
    assert.equal(inertText('see https:\\\\evil.example'), 'see https[:]\\\\evil.example');
    assert.equal(inertText('mixed http:/\\evil'), 'mixed http[:]/\\evil');
    assert.doesNotMatch(inertText('a https://x.example b'), URL_SCHEME_SLASHES);
  });

  it('keeps a title to one bounded line, whatever the version says', () => {
    const version = `2.0.0\r\n${'9'.repeat(500)}`;
    const notice = summarizeSpecChange(
      'Billing\nAPI',
      entry({ info_changes: ['version'] }, { version }),
    );
    assert.doesNotMatch(notice.title, LINE_BREAK);
    assert.ok(notice.headline.length <= 'updated to '.length + MAX_SPEC_CHANGE_TEXT);
    assert.ok(notice.title.startsWith('Billing API spec updated to 2.0.0 999'));
  });
});
