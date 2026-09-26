/**
 * Privileged transitions and destructive deletions record their audit rows in
 * the transaction that makes the change.
 *
 * A row recorded after the commit is lost whenever its insert fails, and the
 * change it describes stays applied with no record of who made it. The actions
 * this matters for are listed in `TRANSACTIONAL_AUDIT_ACTIONS`; this scan parses
 * every server source file and fails when one of them is recorded any other way,
 * so a new call site — or a refactor of an existing one — cannot slip back to
 * the post-commit shape unnoticed. The fault-injection contract in
 * `privileged-audit-contract.ts` proves the rollback itself on every adapter.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { AuditAction, TRANSACTIONAL_AUDIT_ACTIONS } from '../audit/service.js';

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEST_ROOT = join(SOURCE_ROOT, 'test');
/** The catalog itself names every action, and is the one file allowed to. */
const CATALOG = join(SOURCE_ROOT, 'audit', 'service.ts');

/**
 * Calls whose callback runs inside a store transaction and is handed it as
 * `tx`: the transaction itself, and `publishing.remove`'s `recordWithDelete`
 * hook, which that service runs in the transaction that removes the API.
 */
function isTransactionCallee(callee: string): boolean {
  return callee.endsWith('.transaction') || callee === 'publishing.remove';
}

const GUARDED_KEYS = new Set(
  Object.entries(AuditAction)
    .filter(([, value]) => TRANSACTIONAL_AUDIT_ACTIONS.includes(value))
    .map(([key]) => key),
);
const GUARDED_VALUES = new Set<string>(TRANSACTIONAL_AUDIT_ACTIONS);

/** Every non-test TypeScript source under `server/src`. */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== TEST_ROOT) files.push(...sourceFiles(path));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(path);
    }
  }
  return files;
}

/**
 * Whether `tx` is the parameter of a callback handed to a transaction.
 *
 * The nearest enclosing function that declares a parameter of that name is
 * the one it refers to; that function has to be passed straight to a call
 * that runs it in a transaction. A local `const tx = store` is not a
 * parameter, and a helper that merely takes a store called `tx` is not a
 * transaction callback, so neither passes.
 */
function isTransactionParameter(tx: ts.Identifier, source: ts.SourceFile): boolean {
  for (let node: ts.Node | undefined = tx.parent; node; node = node.parent) {
    if (!ts.isFunctionLike(node)) continue;
    const fn = node;
    const declares = fn.parameters.some(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === tx.text,
    );
    if (!declares) continue;
    const call = fn.parent;
    return (
      call !== undefined &&
      ts.isCallExpression(call) &&
      call.arguments.some((argument) => argument === fn) &&
      isTransactionCallee(call.expression.getText(source))
    );
  }
  return false;
}

/**
 * Why `action` (an `AuditAction.X` expression) is not recorded through
 * `audit.forStore(tx).record(actor, AuditAction.X, …)` inside a transaction
 * callback — or `null` when it is.
 */
function misuse(action: ts.PropertyAccessExpression, source: ts.SourceFile): string | null {
  const call = action.parent;
  if (!ts.isCallExpression(call) || call.arguments[1] !== action) {
    return 'is not the action argument of a record() call';
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'record') {
    return 'is passed to something other than record()';
  }
  const receiver = callee.expression;
  if (
    !ts.isCallExpression(receiver) ||
    !ts.isPropertyAccessExpression(receiver.expression) ||
    receiver.expression.name.text !== 'forStore'
  ) {
    return 'is recorded through the root audit service, outside any transaction';
  }
  const [scoped] = receiver.arguments;
  if (receiver.arguments.length !== 1 || scoped === undefined || !ts.isIdentifier(scoped)) {
    return 'is recorded through forStore() on something other than the transaction store';
  }
  if (scoped.text !== 'tx' || !isTransactionParameter(scoped, source)) {
    return 'is recorded through forStore() on a store that is not the transaction callback `tx`';
  }
  return null;
}

interface Scan {
  findings: string[];
  recorded: Set<string>;
}

function scan(): Scan {
  const findings: string[] = [];
  const recorded = new Set<string>();
  for (const path of sourceFiles(SOURCE_ROOT)) {
    if (path === CATALOG) continue;
    const text = readFileSync(path, 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const where = (node: ts.Node): string => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${relative(SOURCE_ROOT, path)}:${line + 1}`;
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'AuditAction' &&
        GUARDED_KEYS.has(node.name.text)
      ) {
        const problem = misuse(node, source);
        if (problem === null) recorded.add(node.name.text);
        else findings.push(`${where(node)} AuditAction.${node.name.text} ${problem}`);
      } else if (
        ts.isIdentifier(node) &&
        node.text === 'AuditAction' &&
        !ts.isImportSpecifier(node.parent) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)
      ) {
        // Destructuring, `AuditAction['…']`, or passing the catalog around
        // would hide an action from the check above.
        findings.push(`${where(node)} uses AuditAction other than as AuditAction.<ACTION>`);
      } else if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        GUARDED_VALUES.has(node.text)
      ) {
        findings.push(`${where(node)} spells out '${node.text}' instead of using AuditAction`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { findings, recorded };
}

describe('transactional audit actions', () => {
  const { findings, recorded } = scan();

  it('are recorded only through audit.forStore(tx) inside a transaction', () => {
    assert.deepEqual(
      findings,
      [],
      'Record these actions with audit.forStore(tx).record(…) inside the store.transaction ' +
        'that makes the change (see TRANSACTIONAL_AUDIT_ACTIONS in audit/service.ts):\n' +
        findings.join('\n'),
    );
  });

  it('are each still recorded somewhere, so the check cannot pass vacuously', () => {
    const missing = [...GUARDED_KEYS].filter((key) => !recorded.has(key)).sort();
    assert.deepEqual(missing, []);
  });

  it('cover the privileged transitions and destructive deletions', () => {
    const required = [
      AuditAction.USER_ROLE_CHANGE,
      AuditAction.USER_DISABLE,
      AuditAction.USER_ENABLE,
      AuditAction.GOD_DISABLE_USER,
      AuditAction.APPLICATION_DELETE,
      AuditAction.API_DELETE,
      AuditAction.GOD_DELETE_API,
    ];
    for (const action of required) assert.ok(TRANSACTIONAL_AUDIT_ACTIONS.includes(action), action);
  });
});
