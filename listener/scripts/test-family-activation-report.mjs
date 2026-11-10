import assert from "node:assert/strict";

const owned = /^\[family=([a-z0-9:-]+(?:,[a-z0-9:-]+)*)\] /;
const definition = /^installed JSON definition: ([a-z0-9:-]+)$/;

export default async function* activationReport(events) {
  for await (const { type, data } of events) {
    if (type === "test:summary" && data.file === undefined) {
      yield JSON.stringify({ summary: data.success, counts: data.counts }) + "\n";
    }
    if (type !== "test:pass" && type !== "test:fail") continue;
    yield JSON.stringify({
      name: data.name,
      status: data.skip || data.todo ? "incomplete" : type === "test:pass" ? "passed" : "failed",
      aggregate: data.details?.error?.failureType === "subtestsFailed",
    }) + "\n";
  }
}

export function selectFamilyActivation(events, familyIds, exitCode) {
  assert(exitCode === 0 || exitCode === 1, "Family JSON tests did not complete");
  const rows = new Map(familyIds.map(id => [id, { id, definition: false, passed: 0, failed: 0, incomplete: 0 }]));
  const summaries = events.filter(event => typeof event.summary === "boolean");
  assert(summaries.length === 1 && summaries[0] === events.at(-1), "incomplete Family JSON test report");
  const { summary, counts } = summaries[0];
  assert.equal(summary, exitCode === 0, "Family JSON report disagrees with test exit");
  assert(counts.tests > 0 && counts.cancelled === 0, "Family JSON tests did not complete");
  const sharedFailures = [];
  let failures = 0, leafFailures = 0;
  for (const event of events.slice(0, -1)) {
    const { name, status, aggregate } = event;
    assert(typeof name === "string" && ["passed", "failed", "incomplete"].includes(status), "invalid Family JSON test result");
    if (status === "failed") failures++;
    if (aggregate) continue; // Individual subtests carry the result.
    if (status === "failed") leafFailures++;
    const installed = definition.exec(name)?.[1];
    const owners = installed ? [installed] : owned.exec(name)?.[1].split(",") ?? [];
    if (owners.length === 0 || owners.some(id => !rows.has(id))) {
      if (status === "failed") sharedFailures.push(name);
      continue;
    }
    for (const id of owners) {
      const row = rows.get(id);
      if (installed && status === "passed") row.definition = true;
      else row[status]++;
    }
  }
  assert.equal(failures, counts.failed, "incomplete Family JSON failure accounting");
  assert(summary || leafFailures > 0, "Family JSON tests failed outside reported cases");
  return {
    sharedFailures,
    families: [...rows.values()].map(row => ({ ...row,
      result: row.failed ? "failed" : !row.definition || !row.passed || row.incomplete ? "incomplete" : "passed",
    })),
  };
}
