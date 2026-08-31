import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const facade = readFileSync(new URL("../src/production-runtime-owner.ts", import.meta.url), "utf8");
const observationOwner = readFileSync(
  new URL("../src/internal/production-terminal-observation-owner.ts", import.meta.url),
  "utf8",
);

test("production facade is the single exact authority-constructor splice", () => {
  const internalImports = [...facade.matchAll(/from ["'](\.\/internal\/[^"']+)["']/g)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(internalImports, [
    "./internal/deployment-runtime-owner.ts",
    "./internal/discovery-source-authority-owner.ts",
    "./internal/economic-safety-owner.ts",
    "./internal/http-family-physical-owner.ts",
    "./internal/performance-deployment-owner.ts",
    "./internal/performance-policy-owner.ts",
    "./internal/production-terminal-observation-owner.ts",
    "./internal/revm-worker-owner.ts",
  ]);
  assert.match(facade, /consumedInfrastructures\.has/);
  assert.match(facade, /readOwnEnumerableDataProperty\(input, key, "runtimeReleaseCompositionFacade"\)/);
  assert.doesNotMatch(facade, /infrastructures\.get\(input\.infrastructure\)/);
  assert.doesNotMatch(facade, /consumedInfrastructures\.(?:has|add)\(input\.infrastructure\)/);
  assert.match(facade, /receiver !== port/);
  assert.doesNotMatch(facade, /\bsign\s*\(|privateKey|broadcast|promote/);
});

test("terminal observation owner has only the fixed collector/store splice", () => {
  const acceptanceImports = [...observationOwner.matchAll(/from ["']([^"']*acceptance\/collectors\/src\/[^"']+)["']/g)]
    .map(match => match[1])
    .sort();
  assert.deepEqual(acceptanceImports, [
    "../../../../acceptance/collectors/src/production-full-family-port.ts",
    "../../../../acceptance/collectors/src/production-six-step-port.ts",
    "../../../../acceptance/collectors/src/production-terminal-phase-port.ts",
    "../../../../acceptance/collectors/src/terminal-phase-locator-index.ts",
  ]);
  assert.doesNotMatch(observationOwner, /acceptance\/(?:gate-core|full-family-facts|six-step-facts|reference)/);
});
