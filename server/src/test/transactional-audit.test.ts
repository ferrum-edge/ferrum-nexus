/**
 * Every audit action is recorded the way `AUDIT_COMMIT_CLASSES` says it is.
 *
 * A row recorded after the commit is lost whenever its insert fails, and the
 * change it describes stays applied with no record of who made it. The catalog
 * classifies every action — deny by default: an unclassified action does not
 * compile, and one this scan cannot find recorded fails it — and the scan
 * parses every server source file and fails when a `transactional` or `intent`
 * action is recorded any other way, so a new call site, or a refactor of an
 * existing one, cannot slip back to the post-commit shape unnoticed. The
 * fault-injection contract in `privileged-audit-contract.ts` proves the
 * rollback itself on every adapter.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  ALL_AUDIT_ACTIONS,
  AUDIT_COMMIT_CLASSES,
  AuditAction,
  TRANSACTIONAL_AUDIT_ACTIONS,
  type AuditCommitClass,
} from '../audit/service.js';

const SOURCE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEST_ROOT = join(SOURCE_ROOT, 'test');
/** The catalog itself names every action, and is the one file allowed to. */
const CATALOG = join(SOURCE_ROOT, 'audit', 'service.ts');

/**
 * Service calls that run a callback argument inside their own transaction and
 * hand it that transaction's store first: `publishing.remove`'s
 * `recordWithDelete` and `access.revoke`'s `recordWithRevoke`.
 */
const HOOK_CALLEES = new Set(['publishing.remove', 'access.revoke']);

/**
 * The names those callbacks go by — the parameter a service invokes one
 * through, or the property an options object passes one under
 * (`recordWithRow`). A hook only records, so every invocation of one is
 * checked to run inside a transaction that writes — and every other mention
 * of one to keep its name, so it cannot be invoked unseen under an alias.
 */
const HOOK_NAMES = new Set(['recordWithDelete', 'recordWithRevoke', 'recordWithRow']);

/**
 * Repository methods that write. A `transactional` action's callback has to
 * call one on the transaction store — on anything but `auditLogs`, whose row is
 * the record rather than the change.
 */
const MUTATING_METHOD =
  /^(create|update|upsert|replace|delete|insert|claim|bind|set|mark|enqueue|release|renew|reschedule|prune|touch|acquire)/;

const CLASS_BY_KEY = new Map<string, AuditCommitClass>(
  Object.entries(AuditAction).map(([key, value]) => [key, AUDIT_COMMIT_CLASSES[value]] as const),
);
const ACTION_VALUES = new Set<string>(ALL_AUDIT_ACTIONS);

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

/* ── Name resolution ────────────────────────────────────────────────────── */

function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindsName(element.name, name),
  );
}

/** The statements a block-like node declares its locals in, if it is one. */
function statementsOf(node: ts.Node): readonly ts.Statement[] | null {
  if (ts.isBlock(node) || ts.isSourceFile(node) || ts.isModuleBlock(node)) return node.statements;
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
  return null;
}

/**
 * The declaration `name` resolves to in `node`, when `node` is a scope that
 * declares it as a local: a variable or function in a block, a loop variable
 * or a caught error.
 */
function localDeclaration(node: ts.Node, name: string): ts.Node | null {
  const statements = statementsOf(node);
  if (statements) {
    for (const statement of statements) {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find((candidate) =>
          bindsName(candidate.name, name),
        );
        if (declaration) return declaration;
      } else if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
        return statement;
      }
    }
    return null;
  }
  if (
    (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
    node.initializer !== undefined &&
    ts.isVariableDeclarationList(node.initializer)
  ) {
    const declaration = node.initializer.declarations.find((candidate) =>
      bindsName(candidate.name, name),
    );
    return declaration ?? null;
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    return bindsName(node.variableDeclaration.name, name) ? node.variableDeclaration : null;
  }
  return null;
}

/** What an identifier refers to. */
type Resolution =
  | { kind: 'parameter'; fn: ts.SignatureDeclaration; index: number }
  | { kind: 'local'; declaration: ts.Node };

/**
 * What `id` refers to: the function it is a parameter of and its position, a
 * local declaration, or `null` when nothing in the file declares it.
 */
function resolve(id: ts.Identifier): Resolution | null {
  for (let node: ts.Node | undefined = id.parent; node; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      const index = node.parameters.findIndex((parameter) => bindsName(parameter.name, id.text));
      if (index !== -1) return { kind: 'parameter', fn: node, index };
    } else {
      const declaration = localDeclaration(node, id.text);
      if (declaration) return { kind: 'local', declaration };
    }
  }
  return null;
}

/** The name a function can be called by within its file, if it has one. */
function helperName(fn: ts.SignatureDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name?.text ?? null;
  const parent = fn.parent;
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(parent) &&
    parent.initializer === fn &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return null;
}

/**
 * Every call of the helper `name` in the file, or `null` when it is referenced
 * any other way — a helper passed around as a value cannot be followed.
 */
function callsOf(
  source: ts.SourceFile,
  name: string,
  fn: ts.SignatureDeclaration,
): ts.CallExpression[] | null {
  const calls: ts.CallExpression[] = [];
  let escaped = false;
  const visit = (node: ts.Node): void => {
    if (escaped) return;
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node !== fn.name &&
      node !== declaredName(fn)
    ) {
      const parent = node.parent;
      if (ts.isCallExpression(parent) && parent.expression === node) calls.push(parent);
      else escaped = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return escaped ? null : calls;
}

function declaredName(fn: ts.SignatureDeclaration): ts.Node | undefined {
  return ts.isVariableDeclaration(fn.parent) ? fn.parent.name : undefined;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/* ── Transaction scopes ─────────────────────────────────────────────────── */

/** A function whose first parameter is a transaction-scoped store. */
interface Scope {
  fn: ts.SignatureDeclaration;
  /** That parameter's name. */
  store: string;
  /**
   * `transaction`: handed straight to a `.transaction(…)` call. `hook`: a
   * callback a service runs inside its own transaction. `helper`: a named
   * function every caller of which hands it a transaction store.
   */
  via: 'transaction' | 'hook' | 'helper';
}

/** The transaction scope `id` is the store parameter of, or `null`. */
function scopeOf(id: ts.Identifier, source: ts.SourceFile, depth = 0): Scope | null {
  const resolved = resolve(id);
  if (resolved?.kind !== 'parameter' || resolved.index !== 0) return null;
  const { fn } = resolved;
  const scope = (via: Scope['via']): Scope => ({ fn, store: id.text, via });
  const parent = fn.parent;
  if (ts.isCallExpression(parent) && parent.arguments.some((argument) => argument === fn)) {
    const callee = parent.expression.getText(source);
    if (callee.endsWith('.transaction')) return scope('transaction');
    if (HOOK_CALLEES.has(callee)) return scope('hook');
    return null;
  }
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === fn &&
    ts.isIdentifier(parent.name) &&
    HOOK_NAMES.has(parent.name.text)
  ) {
    return scope('hook');
  }
  const name = helperName(fn);
  if (name === null || depth >= 5) return null;
  const calls = callsOf(source, name, fn);
  if (calls === null || calls.length === 0) return null;
  for (const call of calls) {
    const [argument] = call.arguments;
    if (argument === undefined || !ts.isIdentifier(argument)) return null;
    if (scopeOf(argument, source, depth + 1) === null) return null;
  }
  return scope('helper');
}

/** Whether `fn` writes through `store.<repo>.<method>(…)` to anything but the audit log. */
function writesThrough(fn: ts.Node, store: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const repo = node.expression.expression;
      if (
        ts.isPropertyAccessExpression(repo) &&
        ts.isIdentifier(repo.expression) &&
        repo.expression.text === store &&
        repo.name.text !== 'auditLogs' &&
        MUTATING_METHOD.test(node.expression.name.text)
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

/** Whether `call` is the operand of an `await`, and nothing else. */
function awaitedDirectly(call: ts.Expression): boolean {
  let parent = call.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return ts.isAwaitExpression(parent);
}

/**
 * Whether `block` has a way out other than falling through to a throw: a
 * `return` anywhere in it, or a `break`/`continue` that leaves it. A function
 * or class nested in it has exits of its own, which are not the block's.
 */
function exitsEarly(block: ts.Block): boolean {
  let found = false;
  const visit = (node: ts.Node, loops: number, switches: number): void => {
    if (found || ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node)) {
      found = true;
    } else if (ts.isBreakStatement(node)) {
      found = node.label !== undefined || loops + switches === 0;
    } else if (ts.isContinueStatement(node)) {
      found = node.label !== undefined || loops === 0;
    } else {
      const loop = ts.isIterationStatement(node, false) ? 1 : 0;
      const switched = ts.isSwitchStatement(node) ? 1 : 0;
      ts.forEachChild(node, (child) => visit(child, loops + loop, switches + switched));
    }
  };
  ts.forEachChild(block, (child) => visit(child, 0, 0));
  return found;
}

/**
 * A `try` between `node` and `boundary` that can complete without rethrowing
 * a failure of `node`: a `catch` with no rethrow of its own, or one that can
 * leave early — `if (…) return;` before its `throw` — or a `finally` that can.
 */
function swallowedBy(node: ts.Node, boundary: ts.Node): ts.TryStatement | null {
  let child: ts.Node = node;
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && current !== boundary) {
    if (ts.isTryStatement(current) && child !== current.finallyBlock) {
      const { catchClause, finallyBlock } = current;
      if (
        current.tryBlock === child &&
        catchClause !== undefined &&
        (!catchClause.block.statements.some(ts.isThrowStatement) || exitsEarly(catchClause.block))
      ) {
        return current;
      }
      if (finallyBlock !== undefined && exitsEarly(finallyBlock)) return current;
    }
    child = current;
    current = current.parent;
  }
  return null;
}

/* ── The scan ───────────────────────────────────────────────────────────── */

/** `AuditAction.X` as the `action` of a `list`/`count` filter: a read, not a record. */
function isFilterRead(action: ts.PropertyAccessExpression): boolean {
  const property = action.parent;
  if (
    !ts.isPropertyAssignment(property) ||
    property.initializer !== action ||
    !ts.isIdentifier(property.name) ||
    property.name.text !== 'action'
  ) {
    return false;
  }
  const filter = property.parent;
  const call = filter.parent;
  const name = ts.isCallExpression(call) ? calleeName(call) : null;
  return (
    ts.isCallExpression(call) &&
    call.arguments[0] === filter &&
    (name === 'list' || name === 'count')
  );
}

/**
 * The store handed to the `forStore(…)` a `record()` call goes through —
 * directly, or through a `const` bound to it — or why there is none.
 */
function scopedStore(receiver: ts.Expression): ts.Identifier | string {
  let target = receiver;
  if (ts.isIdentifier(target)) {
    const resolved = resolve(target);
    const declaration = resolved?.kind === 'local' ? resolved.declaration : null;
    if (
      declaration !== null &&
      ts.isVariableDeclaration(declaration) &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      declaration.initializer !== undefined
    ) {
      target = declaration.initializer;
    }
  }
  if (
    !ts.isCallExpression(target) ||
    !ts.isPropertyAccessExpression(target.expression) ||
    target.expression.name.text !== 'forStore'
  ) {
    return 'is recorded through the root audit service, outside any transaction';
  }
  const [scoped] = target.arguments;
  if (target.arguments.length !== 1 || scoped === undefined || !ts.isIdentifier(scoped)) {
    return 'is recorded through forStore() on something other than a transaction store';
  }
  return scoped;
}

/**
 * Why `action` (an `AuditAction.X` expression) is not recorded the way its
 * class requires — or `null` when it is.
 */
function misuse(
  action: ts.PropertyAccessExpression,
  commit: AuditCommitClass,
  source: ts.SourceFile,
): string | null {
  if (isFilterRead(action)) return null;
  // `cond ? AuditAction.A : AuditAction.B` as the action argument checks both.
  let argument: ts.Expression = action;
  const branch = action.parent;
  if (
    ts.isConditionalExpression(branch) &&
    (branch.whenTrue === action || branch.whenFalse === action)
  ) {
    argument = branch;
  }
  const call = argument.parent;
  if (!ts.isCallExpression(call) || call.arguments[1] !== argument) {
    return 'is not the action argument of a record() call';
  }
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'record') {
    return 'is passed to something other than record()';
  }
  if (commit.kind === 'post_commit') return null;

  const scoped = scopedStore(callee.expression);
  if (typeof scoped === 'string') return scoped;
  const scope = scopeOf(scoped, source);
  if (scope === null) {
    return 'is recorded through forStore() on a store that is not a transaction callback’s';
  }
  if (!awaitedDirectly(call)) {
    return 'is not awaited directly — a floating or caught record cannot roll anything back';
  }
  if (swallowedBy(call, scope.fn)) {
    return 'is recorded in a try whose catch does not always rethrow, or whose finally exits';
  }
  if (
    commit.kind === 'transactional' &&
    commit.rowOnly === undefined &&
    scope.via !== 'hook' &&
    !writesThrough(scope.fn, scope.store)
  ) {
    return `is recorded in a transaction that writes nothing else through \`${scope.store}\``;
  }
  return null;
}

/** Why a hook invocation does not run inside a transaction that writes — or `null`. */
function hookMisuse(call: ts.CallExpression, source: ts.SourceFile): string | null {
  const [argument] = call.arguments;
  if (argument === undefined || !ts.isIdentifier(argument)) {
    return 'is not handed a transaction store';
  }
  const scope = scopeOf(argument, source);
  if (scope === null || scope.via === 'hook') return 'is not invoked inside a transaction callback';
  if (!awaitedDirectly(call)) return 'is not awaited directly';
  if (swallowedBy(call, scope.fn)) {
    return 'is invoked in a try whose catch does not always rethrow, or whose finally exits';
  }
  if (!writesThrough(scope.fn, scope.store)) {
    return `is invoked in a transaction that writes nothing through \`${scope.store}\``;
  }
  return null;
}

/** Whether `name` is the name `node` declares — a parameter, property, variable or function. */
function isDeclaredName(node: ts.Node, name: ts.Identifier): boolean {
  return (
    (ts.isParameter(node) ||
      ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isBindingElement(node)) &&
    node.name === name
  );
}

/**
 * Why a mention of a hook's name hands the hook on under another name — or
 * `null` when it does not.
 *
 * The invocation check above finds a hook by the name it is called through, so
 * a hook bound to any other name (`const write = recordWithRow`, a
 * destructuring rename, an argument) would be invoked unseen. A hook may be
 * called, tested for presence, or passed on under its own name, and nothing
 * else.
 */
function hookAliasing(id: ts.Identifier): string | null {
  const parent = id.parent;
  if (ts.isBindingElement(parent) && parent.propertyName === id) {
    return ts.isIdentifier(parent.name) && parent.name.text === id.text
      ? null
      : 'is destructured under another name';
  }
  if (isDeclaredName(parent, id) || ts.isShorthandPropertyAssignment(parent)) return null;
  // `input.recordWithRow` is the reference; the identifier only names it.
  let reference: ts.Expression = id;
  if (ts.isPropertyAccessExpression(parent)) {
    if (parent.name !== id) return 'has a member read off it, which hides how it is invoked';
    reference = parent;
  }
  let user = reference.parent;
  while (ts.isParenthesizedExpression(user) || ts.isNonNullExpression(user)) {
    reference = user;
    user = user.parent;
  }
  const keepsName = (name: ts.Node): boolean => ts.isIdentifier(name) && name.text === id.text;
  if (ts.isCallExpression(user) && user.expression === reference) return null;
  if (ts.isVariableDeclaration(user) && user.initializer === reference && keepsName(user.name)) {
    return null;
  }
  if (ts.isPropertyAssignment(user) && user.initializer === reference && keepsName(user.name)) {
    return null;
  }
  // Presence tests.
  if (ts.isConditionalExpression(user) && user.condition === reference) return null;
  if (ts.isIfStatement(user) && user.expression === reference) return null;
  if (ts.isPrefixUnaryExpression(user) && user.operator === ts.SyntaxKind.ExclamationToken) {
    return null;
  }
  return 'is bound, passed or read under another name, where its invocation cannot be checked';
}

interface Scan {
  findings: string[];
  /** Keys of the actions recorded — not merely read — the way their class requires. */
  recorded: Set<string>;
  /** Hook names invoked correctly. */
  hooks: Set<string>;
}

function scanSource(label: string, text: string): Scan {
  const findings: string[] = [];
  const recorded = new Set<string>();
  const hooks = new Set<string>();
  const source = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const where = (node: ts.Node): string => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${label}:${line + 1}`;
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      /\/audit\/service(\.js)?$/.test(node.moduleSpecifier.text)
    ) {
      // An alias would hide every use of the catalog, or of the service, from
      // the checks below.
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        findings.push(`${where(node)} imports the audit module as a namespace`);
      } else if (bindings !== undefined) {
        for (const element of bindings.elements) {
          if (element.propertyName !== undefined) {
            findings.push(
              `${where(element)} imports ${element.propertyName.text} as ${element.name.text}`,
            );
          }
        }
      }
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'AuditAction'
    ) {
      const key = node.name.text;
      const commit = CLASS_BY_KEY.get(key);
      const problem = commit === undefined ? 'is not in the catalog' : misuse(node, commit, source);
      if (problem !== null) findings.push(`${where(node)} AuditAction.${key} ${problem}`);
      else if (!isFilterRead(node)) recorded.add(key);
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
      ACTION_VALUES.has(node.text)
    ) {
      findings.push(`${where(node)} spells out '${node.text}' instead of using AuditAction`);
    } else if (ts.isIdentifier(node) && HOOK_NAMES.has(node.text)) {
      const problem = hookAliasing(node);
      if (problem !== null) findings.push(`${where(node)} ${node.text} ${problem}`);
    } else if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      HOOK_NAMES.has(node.text)
    ) {
      findings.push(`${where(node)} spells out the hook name '${node.text}'`);
    } else if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== null && HOOK_NAMES.has(name)) {
        const problem = hookMisuse(node, source);
        if (problem === null) hooks.add(name);
        else findings.push(`${where(node)} ${name}() ${problem}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { findings, recorded, hooks };
}

function scanServer(): Scan {
  const merged: Scan = { findings: [], recorded: new Set(), hooks: new Set() };
  for (const path of sourceFiles(SOURCE_ROOT)) {
    if (path === CATALOG) continue;
    const scan = scanSource(relative(SOURCE_ROOT, path), readFileSync(path, 'utf8'));
    merged.findings.push(...scan.findings);
    for (const key of scan.recorded) merged.recorded.add(key);
    for (const name of scan.hooks) merged.hooks.add(name);
  }
  return merged;
}

/* ── Tests ──────────────────────────────────────────────────────────────── */

describe('audit commit classes', () => {
  it('classify every action in the catalog, and nothing else', () => {
    assert.deepEqual(Object.keys(AUDIT_COMMIT_CLASSES).sort(), [...ALL_AUDIT_ACTIONS].sort());
    for (const action of ALL_AUDIT_ACTIONS) {
      const commit = AUDIT_COMMIT_CLASSES[action];
      if (commit.kind === 'post_commit') {
        assert.ok(commit.reason.trim().length > 0, `${action} needs a reason to commit late`);
      }
      if (commit.kind === 'transactional' && commit.rowOnly !== undefined) {
        assert.ok(commit.rowOnly.trim().length > 0, `${action} needs a reason to commit alone`);
      }
    }
    const guarded = ALL_AUDIT_ACTIONS.filter(
      (action) => AUDIT_COMMIT_CLASSES[action].kind !== 'post_commit',
    );
    assert.deepEqual([...TRANSACTIONAL_AUDIT_ACTIONS].sort(), [...guarded].sort());
  });

  it('put the privileged, destructive and access-granting actions in their transaction', () => {
    const required = [
      AuditAction.USER_ROLE_CHANGE,
      AuditAction.USER_DISABLE,
      AuditAction.USER_ENABLE,
      AuditAction.GOD_DISABLE_USER,
      AuditAction.APPLICATION_DELETE,
      AuditAction.API_DELETE,
      AuditAction.GOD_DELETE_API,
      AuditAction.API_PLUGIN_REMOVE,
      AuditAction.CREDENTIAL_REVOKE,
      AuditAction.ACCESS_APPROVE,
      AuditAction.ACCESS_REVOKE,
      AuditAction.GOD_REVOKE_GRANT,
      AuditAction.ORG_CREATE,
      AuditAction.ORG_UPDATE,
      AuditAction.API_PUBLISH,
      AuditAction.API_UPDATE,
      AuditAction.API_RETIRE,
      AuditAction.API_PLUGIN_SET,
      AuditAction.CREDENTIAL_ISSUE,
      AuditAction.CREDENTIAL_ROTATE,
      AuditAction.TEST_CONSUMER_CREATE,
      AuditAction.GATEWAY_CONSUMER_REPAIR,
      AuditAction.API_SPEC_UPDATE,
      AuditAction.API_SPEC_ROLLBACK,
      AuditAction.API_GATEWAY_RESTORE,
    ];
    for (const action of required) {
      assert.equal(AUDIT_COMMIT_CLASSES[action].kind, 'transactional', action);
    }
    const intents = [
      AuditAction.APPLICATION_DELETE_START,
      AuditAction.API_DELETE_START,
      AuditAction.API_PLUGIN_REMOVE_START,
      AuditAction.CREDENTIAL_REVOKE_START,
      AuditAction.API_SPEC_REVISION_START,
      AuditAction.API_GATEWAY_RESTORE_START,
    ];
    for (const action of intents) assert.equal(AUDIT_COMMIT_CLASSES[action].kind, 'intent', action);
  });
});

describe('transactional audit actions', () => {
  const { findings, recorded, hooks } = scanServer();

  it('are recorded the way their commit class requires', () => {
    assert.deepEqual(
      findings,
      [],
      'Record these actions with audit.forStore(tx).record(…) inside the store.transaction ' +
        'that makes the change (see AUDIT_COMMIT_CLASSES in audit/service.ts):\n' +
        findings.join('\n'),
    );
  });

  it('are each still recorded somewhere, so the check cannot pass vacuously', () => {
    const missing = [...CLASS_BY_KEY.keys()].filter((key) => !recorded.has(key)).sort();
    assert.deepEqual(missing, []);
  });

  it('are handed to hooks that each run inside a writing transaction', () => {
    assert.deepEqual([...hooks].sort(), [...HOOK_NAMES].sort());
  });
});

describe('the transactional audit scan itself', () => {
  const PRELUDE = "import { AuditAction } from '../audit/service.js';\n";

  function findingsOf(text: string): string[] {
    return scanSource('fixture.ts', text).findings;
  }

  function findingsFor(body: string): string[] {
    return findingsOf(PRELUDE + body);
  }

  function assertFlags(body: string, expected: string): void {
    const found = findingsFor(body);
    assert.ok(
      found.some((finding) => finding.includes(expected)),
      `expected a finding containing "${expected}", got:\n${found.join('\n')}`,
    );
  }

  it('accepts a record in the transaction that makes the change', () => {
    const scan = scanSource(
      'fixture.ts',
      PRELUDE +
        `export async function approve(store, audit) {
          await store.transaction(async (tx) => {
            await tx.grants.create({});
            await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target, {}, ip);
          });
        }`,
    );
    assert.deepEqual(scan.findings, []);
    assert.ok(scan.recorded.has('ACCESS_APPROVE'));
  });

  it('accepts a const bound to forStore(tx) and a helper only ever handed tx', () => {
    assert.deepEqual(
      findingsFor(
        `async function write(tx) {
          await tx.users.update('id', {});
          const scoped = audit.forStore(tx);
          await scoped.record(actor, AuditAction.USER_UPDATE, target);
        }
        export async function run(store) {
          await store.transaction((tx) => write(tx));
        }`,
      ),
      [],
    );
  });

  it('flags a record through the root service', () => {
    assertFlags(
      `export async function approve(store, audit) {
        await store.grants.create({});
        await audit.record(actor, AuditAction.ACCESS_APPROVE, target);
      }`,
      'root audit service',
    );
  });

  it('flags a record that is caught rather than awaited', () => {
    assertFlags(
      `export async function approve(store, audit) {
        await store.transaction(async (tx) => {
          await tx.grants.create({});
          await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target).catch(() => {});
        });
      }`,
      'not awaited directly',
    );
  });

  it('flags a record that is not awaited at all', () => {
    assertFlags(
      `export async function approve(store, audit) {
        await store.transaction(async (tx) => {
          await tx.grants.create({});
          void audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target);
        });
      }`,
      'not awaited directly',
    );
  });

  it('flags a record inside a try that swallows its failure', () => {
    assertFlags(
      `export async function approve(store, audit) {
        await store.transaction(async (tx) => {
          await tx.grants.create({});
          try {
            await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target);
          } catch (error) {
            log(error);
          }
        });
      }`,
      'catch does not always rethrow',
    );
  });

  it('flags a transactional record in a transaction that writes nothing else', () => {
    assertFlags(
      `export async function approve(store, audit) {
        await store.grants.create({});
        await store.transaction(async (tx) => {
          await tx.auditLogs.create({});
          await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target);
        });
      }`,
      'writes nothing else',
    );
  });

  it('lets an intent row commit on its own', () => {
    assert.deepEqual(
      findingsFor(
        `export async function remove(store, audit) {
          await store.transaction(async (tx) => {
            await audit.forStore(tx).record(actor, AuditAction.API_DELETE_START, target);
          });
        }`,
      ),
      [],
    );
  });

  it('flags a store that is only named tx, or a helper handed something else', () => {
    assertFlags(
      `export async function approve(store, audit) {
        await store.transaction(async (tx) => {
          await tx.grants.create({});
          const inner = async () => {
            const tx = store;
            await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target);
          };
          await inner();
        });
      }`,
      'not a transaction callback',
    );
    assertFlags(
      `async function write(tx) {
        await tx.grants.create({});
        await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target);
      }
      export async function approve(store) {
        await write(store);
      }`,
      'not a transaction callback',
    );
  });

  it('flags aliases and spelled-out actions', () => {
    const aliased = findingsOf("import { AuditAction as Actions } from '../audit/service.js';\n");
    assert.ok(aliased.some((finding) => finding.includes('imports AuditAction as Actions')));
    const namespaced = findingsOf("import * as auditing from '../audit/service.js';\n");
    assert.ok(namespaced.some((finding) => finding.includes('as a namespace')));
    assertFlags('const Actions = AuditAction;', 'other than as AuditAction.<ACTION>');
    assertFlags("const action = 'access.approve';", "spells out 'access.approve'");
  });

  it('flags a hook invoked outside a writing transaction', () => {
    assertFlags(
      `export async function remove(store, recordWithDelete) {
        await store.apis.delete('id');
        await recordWithDelete?.(store);
      }`,
      'recordWithDelete() is not invoked inside a transaction callback',
    );
  });

  it('flags a catch that can return before it rethrows', () => {
    assertFlags(
      `export async function approve(store, audit) {
        await store.transaction(async (tx) => {
          await tx.grants.create({});
          try {
            await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target);
          } catch (error) {
            if (isRetryable(error)) return;
            throw error;
          }
        });
      }`,
      'catch does not always rethrow',
    );
    assertFlags(
      `export async function approve(store, audit) {
        await store.transaction(async (tx) => {
          await tx.grants.create({});
          for (const attempt of [1, 2]) {
            try {
              await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target);
            } catch (error) {
              if (attempt === 1) continue;
              throw error;
            }
          }
        });
      }`,
      'catch does not always rethrow',
    );
    assertFlags(
      `export async function remove(store, recordWithDelete) {
        await store.transaction(async (tx) => {
          await tx.apis.delete('id');
          try {
            await recordWithDelete?.(tx);
          } finally {
            return;
          }
        });
      }`,
      'recordWithDelete() is invoked in a try whose catch does not always rethrow',
    );
  });

  it('accepts a catch that rethrows on every path', () => {
    assert.deepEqual(
      findingsFor(
        `export async function approve(store, audit) {
          await store.transaction(async (tx) => {
            await tx.grants.create({});
            try {
              await audit.forStore(tx).record(actor, AuditAction.ACCESS_APPROVE, target);
            } catch (error) {
              for (const cleanup of cleanups) {
                if (!cleanup) continue;
                await cleanup().catch(() => undefined);
              }
              if (isConflict(error)) throw conflict('lost');
              throw error;
            }
          });
        }`,
      ),
      [],
    );
  });

  it('flags a hook invoked under an aliased local name', () => {
    assertFlags(
      `export async function revoke(store, recordWithRevoke) {
        const hook = recordWithRevoke;
        await store.transaction(async (tx) => {
          await tx.grants.update('id', {});
          await hook?.(tx);
        });
      }`,
      'recordWithRevoke is bound, passed or read under another name',
    );
    assertFlags(
      `export async function append(store, input) {
        const { recordWithRow: write } = input;
        await write(store, {});
      }`,
      'recordWithRow is destructured under another name',
    );
    assertFlags(
      `export async function append(store, input) {
        await runLater(input.recordWithRow);
      }`,
      'recordWithRow is bound, passed or read under another name',
    );
    assertFlags("const hooks = { write: input['recordWithRow'] };", 'spells out the hook name');
  });

  it('accepts a hook re-bound, tested and passed on under its own name', () => {
    assert.deepEqual(
      findingsFor(
        `export async function append(store, input) {
          const recordWithRow = input.recordWithRow;
          const forwarded = input.recordWithRow ? { recordWithRow: input.recordWithRow } : {};
          if (!recordWithRow) return forwarded;
          await store.transaction(async (tx) => {
            const created = await tx.credentials.create({});
            await recordWithRow(tx, created);
          });
        }`,
      ),
      [],
    );
  });

  it('reads a filter on an action without counting it as recorded', () => {
    const scan = scanSource(
      'fixture.ts',
      PRELUDE + 'export const used = () => audit.count({ action: AuditAction.GOD_BROADCAST });',
    );
    assert.deepEqual(scan.findings, []);
    assert.equal(scan.recorded.has('GOD_BROADCAST'), false);
  });
});
