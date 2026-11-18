import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from '../listener/node_modules/typescript/lib/typescript.js';
import { normalizeSelectorFamilyDefinition } from '../listener/src/searcher/venues/selector-family-definition.ts';

// Inspect declarations before importing the catalog: imports freeze activation.
// Parse syntax rather than matching formatting, and never execute source text.
export function activationKeys(source, file = 'entry.ts') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Map(), declarations = [];
  for (const node of ast.statements) if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
    const path = resolve(dirname(file), node.moduleSpecifier.text.replace(/\.js$/, '.ts'));
    if (node.importClause?.name) imports.set(node.importClause.name.text, { path, name: 'default' });
    const names = node.importClause?.namedBindings;
    if (names && ts.isNamedImports(names)) for (const item of names.elements) if (!item.isTypeOnly)
      imports.set(item.name.text, { path, name: item.propertyName?.text ?? item.name.text });
  }
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      assert(!['plugin', 'productionFamilyModule', 'activation'].includes(node.name.text), 'Retired production activation entry');
      if (node.name.text === 'selectorFamilyModule') declarations.push(node);
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'defineFamilyActivation')
      assert.fail('Retired activation constructor; use selector-family/v2 JSON');
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(declarations.length, 1, 'Missing/ambiguous v2 selectorFamilyModule');
  const declaration = declarations[0], call = declaration.initializer;
  assert(ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.arguments.length === 1 &&
    ts.isIdentifier(call.arguments[0]) && !(call.typeArguments?.length), 'Invalid v2 module declaration');
  const factory = imports.get(call.expression.text), definition = imports.get(call.arguments[0].text);
  assert(factory?.name === 'defineSelectorFamilyModule' && factory.path === resolve(dirname(file), '../selector-family-module.ts'), 'Invalid v2 module factory');
  assert(definition?.name === 'default' && definition.path.endsWith('.json'), 'v2 activation requires its authored JSON');
  const document = normalizeSelectorFamilyDefinition(JSON.parse(readFileSync(definition.path, 'utf8')));
  const key = document.activation?.envKey ?? `SEARCHER_FAMILY_SELECTOR_${document.selector.slice(2).toUpperCase()}_ENABLED`;
  assert.match(key, /^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/, 'Invalid activation key');
  return [key];
}
function readyFamilyKeys(root) {
  const dir = join(root, 'listener/src/searcher/venues/production-families');
  const keys = readdirSync(dir).filter(file => file.endsWith('.production.ts')).sort()
    .flatMap(file => activationKeys(readFileSync(join(dir, file), 'utf8'), join(dir, file)));
  assert(new Set(keys).size === keys.length, 'Duplicate production activation key');
  return keys;
}

export function enableReadyFamilies(root, env = process.env) {
  const keys = readyFamilyKeys(root);
  for (const key of keys) env[key] = '1';
  return keys;
}

export function applyReadyLiveFamilyFlags(root, config, env = process.env) {
  const keys = readyFamilyKeys(root);
  const allowed = new Set(keys);
  const active = [];
  for (const [key, value] of Object.entries(config)) {
    if (!/^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/.test(key)) continue;
    assert(value === '0' || value === '1', 'Invalid live Family flag: ' + key);
    if (value === '1') {
      assert(allowed.has(key), 'Enabled live Family is missing from the current checkout: ' + key);
      active.push(key);
    }
  }
  assert(active.length, 'Live config has no enabled Families');
  for (const key of keys) env[key] = config[key] ?? '0';
  return active.sort();
}
