import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from '../listener/node_modules/typescript/lib/typescript.js';

// Inspect declarations before importing the catalog: imports freeze activation.
// Parse syntax rather than matching formatting, and never execute source text.
export function activationKeys(source, file = 'entry.ts') {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const keys = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'defineFamilyActivation') {
      assert.equal(node.arguments.length, 1, 'Invalid activation declaration');
      const value = node.arguments[0];
      assert(ts.isObjectLiteralExpression(value), 'Activation must be a literal declaration');
      for (const property of value.properties) {
        assert(ts.isPropertyAssignment(property), 'Activation must use literal properties');
        if (property.name.text !== 'envKey') continue;
        assert(ts.isStringLiteral(property.initializer), 'Activation envKey must be a literal');
        const key = property.initializer.text;
        assert.match(key, /^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/, 'Invalid activation key');
        keys.push(key);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert(new Set(keys).size === keys.length, 'Duplicate activation key');
  return keys;
}
export function enableReadyFamilies(root, env = process.env) {
  const dir = join(root, 'listener/src/searcher/venues/production-families');
  const keys = readdirSync(dir).filter(file => file.endsWith('.production.ts')).sort()
    .flatMap(file => activationKeys(readFileSync(join(dir, file), 'utf8'), file));
  assert(new Set(keys).size === keys.length, 'Duplicate production activation key');
  for (const key of keys) env[key] = '1';
  return keys;
}
